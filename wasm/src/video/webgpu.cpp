// from https://github.com/cwoffenden/hello-webgpu/blob/main/src/main.cpp

#include <emscripten/emscripten.h>
#include <emscripten/html5.h>
#include <emscripten/html5_webgpu.h>
#include <fstream>
#include <functional>
#include <spdlog/spdlog.h>
#include <sstream>
#include <webgpu/webgpu_cpp.h>

extern "C" {
#include <libavutil/frame.h>
}

struct WebGPUContext {
  int textureWidth = 0;
  int textureHeight = 0;
  WGPUDevice device = nullptr;
  WGPUSurface surface = nullptr;
  WGPUSwapChain swapChain = nullptr;
  // スワップチェーン(= canvas のバッファ)の大きさ。
  // 表示サイズに合わせて作り直す。
  int swapChainWidth = 0;
  int swapChainHeight = 0;
  WGPUQueue queue = nullptr;
  // インターレース解除フィルタ。どれも同じバインドグループレイアウトなので、
  // パイプラインだけ差し替えて使う。
  // yadif/bwdif は残すフィールド(parity)ごとに 2 本ずつ持つ。倍レート出力では
  // 同じフレームを両方で描く。
  WGPUComputePipeline passthruPipeline = nullptr;
  WGPUComputePipeline yadifPipeline[2] = {}, bwdifPipeline[2] = {};
  WGPURenderPipeline pipeline = nullptr;
  WGPUBindGroupLayout filterBindGroupLayout = nullptr,
                      bindGroupLayout = nullptr;
  // prev/cur/next は 3 枚を使い回す。毎フレーム next->cur->prev とコピーする
  // 代わりに、書き込む先を 1 枚ずつずらして、どれが prev/cur/next かを
  // バインドグループ側で表す (textureRotation が今 next にあたる添字)。
  int textureRotation = 0;
  WGPUTexture textureY[3] = {}, textureU[3] = {}, textureV[3] = {};
  WGPUTextureView viewY[3] = {}, viewU[3] = {}, viewV[3] = {};
  WGPUTexture frameTexture = nullptr;
  WGPUTextureView frameView = nullptr;
  WGPUBindGroup filterBindGroup[3] = {}, bindGroup = nullptr;
  WGPUSampler sampler = nullptr;
};

static WebGPUContext ctx;

/**
 * Helper to create a shader from WGSL source.
 *
 * \param[in] code WGSL shader source
 * \param[in] label optional shader name
 */
static WGPUShaderModule createShader(const char *const code,
                                     const char *label = nullptr) {
  WGPUShaderModuleWGSLDescriptor wgsl = {};
  wgsl.chain.sType = WGPUSType_ShaderModuleWGSLDescriptor;
  wgsl.code = code;
  WGPUShaderModuleDescriptor desc = {};
  desc.nextInChain = reinterpret_cast<WGPUChainedStruct *>(&wgsl);
  desc.label = label;
  return wgpuDeviceCreateShaderModule(ctx.device, &desc);
}

// createTextures() が作るものは「テクスチャとビュー」だけではない。サンプラと
// バインドグループも毎回作り直しているので、ここで一緒に解放しないと解像度が
// 変わるたびにリークする。
static void releaseTextures() {
  for (int i = 0; i < 3; i++) {
    wgpuTextureViewRelease(ctx.viewY[i]);
    wgpuTextureViewRelease(ctx.viewU[i]);
    wgpuTextureViewRelease(ctx.viewV[i]);
    wgpuTextureRelease(ctx.textureY[i]);
    wgpuTextureRelease(ctx.textureU[i]);
    wgpuTextureRelease(ctx.textureV[i]);
  }

  wgpuTextureViewRelease(ctx.frameView);
  wgpuTextureRelease(ctx.frameTexture);

  for (int i = 0; i < 3; i++) {
    if (ctx.filterBindGroup[i] != nullptr) {
      wgpuBindGroupRelease(ctx.filterBindGroup[i]);
      ctx.filterBindGroup[i] = nullptr;
    }
  }
  if (ctx.bindGroup != nullptr) {
    wgpuBindGroupRelease(ctx.bindGroup);
    ctx.bindGroup = nullptr;
  }
  if (ctx.sampler != nullptr) {
    wgpuSamplerRelease(ctx.sampler);
    ctx.sampler = nullptr;
  }
}

static void createTextures(int width, int height) {
  WGPUExtent3D size = {};
  size.width = width;
  size.height = height;
  size.depthOrArrayLayers = 1;

  WGPUExtent3D uvSize = {};
  uvSize.width = width / 2;
  uvSize.height = height / 2;
  uvSize.depthOrArrayLayers = 1;

  WGPUTextureDescriptor textureDesc = {};
  textureDesc.dimension = WGPUTextureDimension_2D;
  textureDesc.format = WGPUTextureFormat_R8Unorm;
  // テクスチャ間コピーをやめたので CopySrc は要らない。
  textureDesc.usage =
      WGPUTextureUsage_CopyDst | WGPUTextureUsage_TextureBinding;
  textureDesc.sampleCount = 1;
  textureDesc.mipLevelCount = 1;

  textureDesc.size = size;
  for (int i = 0; i < 3; i++) {
    ctx.textureY[i] = wgpuDeviceCreateTexture(ctx.device, &textureDesc);
  }

  textureDesc.size = uvSize;
  for (int i = 0; i < 3; i++) {
    ctx.textureU[i] = wgpuDeviceCreateTexture(ctx.device, &textureDesc);
    ctx.textureV[i] = wgpuDeviceCreateTexture(ctx.device, &textureDesc);
  }

  textureDesc.format = WGPUTextureFormat_RGBA8Unorm;
  textureDesc.usage = WGPUTextureUsage_CopyDst |
                      WGPUTextureUsage_TextureBinding |
                      WGPUTextureUsage_StorageBinding;
  textureDesc.size = size;
  ctx.frameTexture = wgpuDeviceCreateTexture(ctx.device, &textureDesc);

  WGPUSamplerDescriptor samplerDesc = {};
  samplerDesc.magFilter = WGPUFilterMode_Linear;
  samplerDesc.minFilter = WGPUFilterMode_Linear;
  samplerDesc.addressModeU = WGPUAddressMode_ClampToEdge;
  samplerDesc.addressModeV = WGPUAddressMode_ClampToEdge;

  ctx.sampler = wgpuDeviceCreateSampler(ctx.device, &samplerDesc);

  WGPUTextureViewDescriptor viewDesc = {};
  viewDesc.dimension = WGPUTextureViewDimension_2D;
  viewDesc.format = WGPUTextureFormat_R8Unorm;
  viewDesc.arrayLayerCount = 1;
  viewDesc.mipLevelCount = 1;
  viewDesc.aspect = WGPUTextureAspect_All;

  for (int i = 0; i < 3; i++) {
    ctx.viewY[i] = wgpuTextureCreateView(ctx.textureY[i], &viewDesc);
    ctx.viewU[i] = wgpuTextureCreateView(ctx.textureU[i], &viewDesc);
    ctx.viewV[i] = wgpuTextureCreateView(ctx.textureV[i], &viewDesc);
  }

  viewDesc.format = WGPUTextureFormat_RGBA8Unorm;
  ctx.frameView = wgpuTextureCreateView(ctx.frameTexture, &viewDesc);

  // 書き込み先を 1 枚ずつずらすので、rotation ごとに prev/cur/next の割り当てが
  // 変わる。バインドグループは 3 通りを作り置きしておき、描画時に選ぶ。
  for (int i = 0; i < 3; i++) {
    WGPUBindGroupEntry filterEntries[] = {
        {.binding = 0, .sampler = ctx.sampler},
        {.binding = 1, .textureView = ctx.frameView},
        {.binding = 2, .textureView = ctx.viewY[(i + 2) % 3]}, // cur
        {.binding = 3, .textureView = ctx.viewU[(i + 2) % 3]},
        {.binding = 4, .textureView = ctx.viewV[(i + 2) % 3]},
        {.binding = 5, .textureView = ctx.viewY[(i + 1) % 3]}, // prev
        {.binding = 6, .textureView = ctx.viewU[(i + 1) % 3]},
        {.binding = 7, .textureView = ctx.viewV[(i + 1) % 3]},
        {.binding = 8, .textureView = ctx.viewY[i]}, // next
        {.binding = 9, .textureView = ctx.viewU[i]},
        {.binding = 10, .textureView = ctx.viewV[i]},
    };
    WGPUBindGroupDescriptor filterBgDesc = {};
    filterBgDesc.layout = ctx.filterBindGroupLayout;
    filterBgDesc.entryCount = sizeof(filterEntries) / sizeof(filterEntries[0]);
    filterBgDesc.entries = filterEntries;
    ctx.filterBindGroup[i] =
        wgpuDeviceCreateBindGroup(ctx.device, &filterBgDesc);
  }

  WGPUBindGroupEntry bgEntries[] = {
      {.binding = 0, .sampler = ctx.sampler},
      {.binding = 1, .textureView = ctx.frameView},
  };
  WGPUBindGroupDescriptor bgDesc = {};
  bgDesc.layout = ctx.bindGroupLayout;
  bgDesc.entryCount = sizeof(bgEntries) / sizeof(bgEntries[0]);
  bgDesc.entries = bgEntries;
  ctx.bindGroup = wgpuDeviceCreateBindGroup(ctx.device, &bgDesc);

  ctx.textureRotation = 0;
  ctx.textureWidth = width;
  ctx.textureHeight = height;
}

static void createPipeline() {
  std::string vertWgsl =
#include "shaders/simple.vert.wgsl"
      ;
  std::string fragWgsl =
#include "shaders/simple.frag.wgsl"
      ;
  std::string passthruWgsl =
#include "shaders/passthru.compute.wgsl"
      ;
  std::string yadifWgsl =
#include "shaders/yadif.frag.wgsl"
      ;
  std::string bwdifWgsl =
#include "shaders/bwdif.compute.wgsl"
      ;

  WGPUShaderModule vertMod = createShader(vertWgsl.c_str());
  WGPUShaderModule fragMod = createShader(fragWgsl.c_str());
  WGPUShaderModule passthruMod = createShader(passthruWgsl.c_str());
  WGPUShaderModule bwdifMod = createShader(bwdifWgsl.c_str());
  WGPUShaderModule yadifMod = createShader(yadifWgsl.c_str());

  WGPUSamplerBindingLayout samplerLayout = {};
  samplerLayout.type = WGPUSamplerBindingType_Filtering;

  WGPUTextureBindingLayout textureLayout = {};
  textureLayout.sampleType = WGPUTextureSampleType_Float;
  textureLayout.multisampled = false;
  textureLayout.viewDimension = WGPUTextureViewDimension_2D;

  WGPUStorageTextureBindingLayout storageTextureLayout = {};
  storageTextureLayout.format = WGPUTextureFormat_RGBA8Unorm;
  storageTextureLayout.access = WGPUStorageTextureAccess_WriteOnly;
  storageTextureLayout.viewDimension = WGPUTextureViewDimension_2D;

  WGPUBindGroupLayoutEntry bglEntries[] = {
      {.binding = 0,
       .visibility = WGPUShaderStage_Fragment | WGPUShaderStage_Compute,
       .sampler = samplerLayout},
      {.binding = 1,
       .visibility = WGPUShaderStage_Compute,
       .storageTexture = storageTextureLayout},
      {.binding = 2,
       .visibility = WGPUShaderStage_Compute,
       .texture = textureLayout},
      {.binding = 3,
       .visibility = WGPUShaderStage_Compute,
       .texture = textureLayout},
      {.binding = 4,
       .visibility = WGPUShaderStage_Compute,
       .texture = textureLayout},
      {.binding = 5,
       .visibility = WGPUShaderStage_Compute,
       .texture = textureLayout},
      {.binding = 6,
       .visibility = WGPUShaderStage_Compute,
       .texture = textureLayout},
      {.binding = 7,
       .visibility = WGPUShaderStage_Compute,
       .texture = textureLayout},
      {.binding = 8,
       .visibility = WGPUShaderStage_Compute,
       .texture = textureLayout},
      {.binding = 9,
       .visibility = WGPUShaderStage_Compute,
       .texture = textureLayout},
      {.binding = 10,
       .visibility = WGPUShaderStage_Compute,
       .texture = textureLayout},
  };

  WGPUBindGroupLayoutDescriptor bglDesc = {};
  bglDesc.entryCount = sizeof(bglEntries) / sizeof(bglEntries[0]);
  bglDesc.entries = bglEntries;
  ctx.filterBindGroupLayout =
      wgpuDeviceCreateBindGroupLayout(ctx.device, &bglDesc);

  bglEntries[1] = {
      .binding = 1,
      .visibility = WGPUShaderStage_Fragment,
      .texture = textureLayout,
  };

  bglDesc.entryCount = 2;
  ctx.bindGroupLayout = wgpuDeviceCreateBindGroupLayout(ctx.device, &bglDesc);

  WGPUPipelineLayoutDescriptor layoutDesc = {};
  layoutDesc.bindGroupLayoutCount = 1;
  layoutDesc.bindGroupLayouts = &ctx.filterBindGroupLayout;
  WGPUPipelineLayout filterPipelineLayout =
      wgpuDeviceCreatePipelineLayout(ctx.device, &layoutDesc);

  layoutDesc.bindGroupLayouts = &ctx.bindGroupLayout;
  WGPUPipelineLayout pipelineLayout =
      wgpuDeviceCreatePipelineLayout(ctx.device, &layoutDesc);

  WGPUBlendState blend = {};
  blend.color.operation = WGPUBlendOperation_Add;
  blend.color.srcFactor = WGPUBlendFactor_One;
  blend.color.dstFactor = WGPUBlendFactor_One;
  blend.alpha.operation = WGPUBlendOperation_Add;
  blend.alpha.srcFactor = WGPUBlendFactor_One;
  blend.alpha.dstFactor = WGPUBlendFactor_One;

  WGPUColorTargetState colorTarget = {};
  colorTarget.format = WGPUTextureFormat_BGRA8Unorm;
  colorTarget.blend = &blend;
  colorTarget.writeMask = WGPUColorWriteMask_All;

  WGPUFragmentState fragment = {};
  fragment.module = fragMod;
  fragment.entryPoint = "main";
  fragment.targetCount = 1;
  fragment.targets = &colorTarget;

  WGPURenderPipelineDescriptor desc = {};
  desc.fragment = &fragment;

  desc.layout = pipelineLayout;
  desc.depthStencil = nullptr;

  desc.vertex.module = vertMod;
  desc.vertex.entryPoint = "main";

  desc.multisample.count = 1;
  desc.multisample.mask = 0xFFFFFFFF;
  desc.multisample.alphaToCoverageEnabled = false;

  desc.primitive.frontFace = WGPUFrontFace_CCW;
  desc.primitive.cullMode = WGPUCullMode_None;
  desc.primitive.topology = WGPUPrimitiveTopology_TriangleList;
  desc.primitive.stripIndexFormat = WGPUIndexFormat_Undefined;

  ctx.pipeline = wgpuDeviceCreateRenderPipeline(ctx.device, &desc);

  const auto createFilterPipeline = [&](WGPUShaderModule module,
                                        const WGPUConstantEntry *parity) {
    WGPUProgrammableStageDescriptor compStageDesc = {
        .module = module,
        .entryPoint = "main",
        .constantCount = parity ? 1u : 0u,
        .constants = parity,
    };
    WGPUComputePipelineDescriptor compDesc = {.layout = filterPipelineLayout,
                                              .compute = compStageDesc};
    return wgpuDeviceCreateComputePipeline(ctx.device, &compDesc);
  };
  ctx.passthruPipeline = createFilterPipeline(passthruMod, nullptr);
  for (int i = 0; i < 2; i++) {
    WGPUConstantEntry parityEntry = {.key = "parity",
                                     .value = static_cast<double>(i)};
    ctx.yadifPipeline[i] = createFilterPipeline(yadifMod, &parityEntry);
    ctx.bwdifPipeline[i] = createFilterPipeline(bwdifMod, &parityEntry);
  }

  // partial clean-up (just move to the end, no?)
  wgpuPipelineLayoutRelease(filterPipelineLayout);
  wgpuPipelineLayoutRelease(pipelineLayout);

  wgpuShaderModuleRelease(fragMod);
  wgpuShaderModuleRelease(vertMod);
}

// スワップチェーンを作り直す。emscripten の実装はここで canvas の
// width/height も descriptor の値に合わせるので、描画バッファの解像度は
// この関数だけで決まる。
static void createSwapChain(int width, int height) {
  WGPUSwapChainDescriptor swapDesc = {};
  swapDesc.usage = WGPUTextureUsage_RenderAttachment;
  swapDesc.format = WGPUTextureFormat_BGRA8Unorm;
  swapDesc.width = static_cast<uint32_t>(width);
  swapDesc.height = static_cast<uint32_t>(height);
  swapDesc.presentMode = WGPUPresentMode_Fifo;

  ctx.swapChain = wgpuDeviceCreateSwapChain(ctx.device, ctx.surface, &swapDesc);
  ctx.swapChainWidth = width;
  ctx.swapChainHeight = height;
  spdlog::info("swap chain: {}x{}", width, height);
}

// 表示サイズ(デバイスピクセル)を JS から教えてもらって描画バッファを合わせる。
// 固定サイズのままだと、表示が大きいときはブラウザによる引き伸ばしで甘くなり、
// 逆に映像が 1920x1080 より大きいとき(4K/8K のソフトデコード)は、その解像度が
// ここで捨てられてしまう。
void resizeSwapChain(int width, int height) {
  if (width <= 0 || height <= 0 || ctx.surface == nullptr) {
    return;
  }
  if (width == ctx.swapChainWidth && height == ctx.swapChainHeight) {
    return;
  }
  if (ctx.swapChain != nullptr) {
    wgpuSwapChainRelease(ctx.swapChain);
    ctx.swapChain = nullptr;
  }
  createSwapChain(width, height);
}

void initWebGpu() {
  ctx.device = emscripten_webgpu_get_device();

  ctx.queue = wgpuDeviceGetQueue(ctx.device);

  // pipeline/buffer
  createPipeline();

  // create swapchain?
  WGPUSurfaceDescriptorFromCanvasHTMLSelector canvasDesc = {};
  canvasDesc.chain.sType = WGPUSType_SurfaceDescriptorFromCanvasHTMLSelector;
  canvasDesc.selector = "video";

  WGPUSurfaceDescriptor surfaceDesc = {};
  surfaceDesc.nextInChain = reinterpret_cast<WGPUChainedStruct *>(&canvasDesc);

  ctx.surface = wgpuInstanceCreateSurface(nullptr, &surfaceDesc);

  createSwapChain(1920, 1080);

  // dummy texture.
  createTextures(1920, 1080);
}

static void drawWebGpuUpload(AVFrame *frame);
static void drawWebGpuRender(bool secondField, bool deinterlaceFlag,
                             bool bwdifFlag);

// renderFlag が false のときはテクスチャの取り込みだけ行い、画面には出さない。
// 逆テレシネで重複フレームを飛ばすときに使う。取り込み自体を飛ばすと
// prev/cur/next の並びが崩れるので、スキップするのは描画だけ。
//
// frame が nullptr のときは取り込みを行わず、直前に取り込んだフレームの
// もう一方のフィールドを描く (倍レート出力)。
void drawWebGpu(AVFrame *frame, bool renderFlag, bool deinterlaceFlag,
                bool bwdifFlag) {
  if (frame != nullptr) {
    drawWebGpuUpload(frame);
  }

  if (!renderFlag) {
    return;
  }

  drawWebGpuRender(frame == nullptr, deinterlaceFlag, bwdifFlag);
}

// フレームを prev/cur/next のリングへ取り込む。
static void drawWebGpuUpload(AVFrame *frame) {
  if (frame->width != ctx.textureWidth || frame->height != ctx.textureHeight) {
    releaseTextures();
    createTextures(frame->width, frame->height);
  }

  WGPUExtent3D copySize = {
      .width = static_cast<uint32_t>(frame->width),
      .height = static_cast<uint32_t>(frame->height),
      .depthOrArrayLayers = 1,
  };

  WGPUExtent3D copySizeuv = {
      .width = static_cast<uint32_t>(frame->width / 2),
      .height = static_cast<uint32_t>(frame->height / 2),
      .depthOrArrayLayers = 1,
  };

  // AVFrame の各行は linesize バイト間隔で並ぶ (アライメントのため width より
  // 大きいことがある)。width を渡すと行がずれて映像が斜めになるので、実際の
  // ストライドを bytesPerRow として渡す。
  WGPUTextureDataLayout textureDataLayout = {
      .offset = 0,
      .bytesPerRow = static_cast<uint32_t>(frame->linesize[0]),
      .rowsPerImage = static_cast<uint32_t>(frame->height),
  };

  WGPUTextureDataLayout textureDataLayoutU = {
      .offset = 0,
      .bytesPerRow = static_cast<uint32_t>(frame->linesize[1]),
      .rowsPerImage = static_cast<uint32_t>(frame->height / 2),
  };

  WGPUTextureDataLayout textureDataLayoutV = {
      .offset = 0,
      .bytesPerRow = static_cast<uint32_t>(frame->linesize[2]),
      .rowsPerImage = static_cast<uint32_t>(frame->height / 2),
  };

  WGPUOrigin3D origin = {};

  WGPUImageCopyTexture copyTexture = {
      .mipLevel = 0,
      .origin = origin,
      .aspect = WGPUTextureAspect::WGPUTextureAspect_All,
  };

  // 今回のフレームを next として書き込む。1 枚ずらすことで、前回の next が
  // cur に、前々回の next が prev になる。
  ctx.textureRotation = (ctx.textureRotation + 1) % 3;

  copyTexture.texture = ctx.textureY[ctx.textureRotation];
  wgpuQueueWriteTexture(ctx.queue, &copyTexture, frame->data[0],
                        (size_t)frame->height * frame->linesize[0],
                        &textureDataLayout, &copySize);

  copyTexture.texture = ctx.textureU[ctx.textureRotation];
  wgpuQueueWriteTexture(ctx.queue, &copyTexture, frame->data[1],
                        (size_t)(frame->height / 2) * frame->linesize[1],
                        &textureDataLayoutU, &copySizeuv);

  copyTexture.texture = ctx.textureV[ctx.textureRotation];
  wgpuQueueWriteTexture(ctx.queue, &copyTexture, frame->data[2],
                        (size_t)(frame->height / 2) * frame->linesize[2],
                        &textureDataLayoutV, &copySizeuv);
}

// 取り込み済みのテクスチャから 1 枚描いて画面に出す。
static void drawWebGpuRender(bool secondField, bool deinterlaceFlag,
                             bool bwdifFlag) {
  WGPUTextureView backBufView =
      wgpuSwapChainGetCurrentTextureView(ctx.swapChain); // create textureView

  WGPURenderPassColorAttachment colorDesc = {};
  colorDesc.view = backBufView;
  colorDesc.loadOp = WGPULoadOp_Clear;
  colorDesc.storeOp = WGPUStoreOp_Store;
  colorDesc.depthSlice = WGPU_DEPTH_SLICE_UNDEFINED;
  colorDesc.clearValue.r = 0.0f;
  colorDesc.clearValue.g = 0.0f;
  colorDesc.clearValue.b = 0.0f;
  colorDesc.clearValue.a = 1.0f;

  WGPUComputePassDescriptor compPassDesc = {};

  WGPURenderPassDescriptor renderPassDesc = {};
  renderPassDesc.colorAttachmentCount = 1;
  renderPassDesc.colorAttachments = &colorDesc;

  WGPUCommandEncoder encoder =
      wgpuDeviceCreateCommandEncoder(ctx.device, nullptr); // create encoder

  WGPUComputePassEncoder compPass =
      wgpuCommandEncoderBeginComputePass(encoder, &compPassDesc);
  const int parity = secondField ? 1 : 0;
  WGPUComputePipeline filterPipeline = ctx.yadifPipeline[parity];
  if (!deinterlaceFlag) {
    filterPipeline = ctx.passthruPipeline;
  } else if (bwdifFlag) {
    filterPipeline = ctx.bwdifPipeline[parity];
  }
  wgpuComputePassEncoderSetPipeline(compPass, filterPipeline);
  wgpuComputePassEncoderSetBindGroup(
      compPass, 0, ctx.filterBindGroup[ctx.textureRotation], 0, 0);
  // 1 invocation が輝度 2x2 画素を処理し、ワークグループは 16x4。切り捨てで
  // 割ると幅/高さが端数のとき右端・下端が処理されないため切り上げる (範囲外
  // の textureStore は WGSL 仕様上無視される)。
  const uint32_t dispatchX = ((uint32_t)ctx.textureWidth + 31) / 32;
  const uint32_t dispatchY = ((uint32_t)ctx.textureHeight + 7) / 8;
  wgpuComputePassEncoderDispatchWorkgroups(compPass, dispatchX, dispatchY, 1);
  wgpuComputePassEncoderEnd(compPass);
  wgpuComputePassEncoderRelease(compPass);

  WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(
      encoder, &renderPassDesc); // create pass
  wgpuRenderPassEncoderSetPipeline(pass, ctx.pipeline);
  wgpuRenderPassEncoderSetBindGroup(pass, 0, ctx.bindGroup, 0, 0);
  wgpuRenderPassEncoderDraw(pass, 6, 1, 0, 0);

  wgpuRenderPassEncoderEnd(pass);
  wgpuRenderPassEncoderRelease(pass); // release pass

  WGPUCommandBuffer commands =
      wgpuCommandEncoderFinish(encoder, nullptr); // create commands
  wgpuCommandEncoderRelease(encoder);             // release encoder

  wgpuQueueSubmit(ctx.queue, 1, &commands);
  wgpuCommandBufferRelease(commands);  // release commands
  wgpuTextureViewRelease(backBufView); // release textureView
}
