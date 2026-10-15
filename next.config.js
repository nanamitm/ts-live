const { execFileSync } = require('child_process')

const git = (...args) =>
  execFileSync('git', args, {
    cwd: __dirname,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()

// ビルドしたコミット (git describe --tags --always --dirty 相当)。TVTest の
// TVTestVersionHashGen.bat と同じく、ビルドのたびに取得して埋め込む。git が
// 無ければ unknown。public/wasm はコミットしてあるが CI がビルドし直して
// 上書きするので、未コミットの変更 (-dirty) には数えない。
const describeCommit = () => {
  try {
    const described = git('describe', '--tags', '--always')
    const changes = git(
      'status',
      '--porcelain',
      '--untracked-files=no',
      '--',
      '.',
      ':(exclude)public/wasm'
    )
    return changes ? `${described}-dirty` : described
  } catch {
    return 'unknown'
  }
}

/** @type {import('next').NextConfig} */
module.exports = {
  // target: 'serverless',
  // async rewrites () {
  //   return [
  //     {
  //       source: '/:any*',
  //       destination: '/'
  //     }
  //   ]
  // },
  env: {
    VERSION: process.env.VERSION,
    COMMIT: describeCommit()
  },
  // NOTE: 静的エクスポート(next export)では headers/rewrites は反映されない。
  // 本番(Cloudflare Pages)のヘッダーは public/_headers が正となるので、両者を
  // 変更するときは必ず揃えること。ここは `yarn dev` 用。
  async headers () {
    return [
      {
        // SharedArrayBuffer(WASM thread)に必要な cross-origin isolation。
        source: '/:path*',
        headers: [
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'require-corp'
          },
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin'
          }
        ]
      },
      {
        // WASM 一式は他オリジンからの取得を許可する。HTML までワイルドカードで
        // 開ける必要は無いのでアセットに限定する。
        source: '/wasm/:path*',
        headers: [
          {
            key: 'Access-Control-Allow-Origin',
            value: '*'
          }
        ]
      }
    ]
  },
  // 開発コンテナの mirakc を叩くための開発専用 rewrite。
  async rewrites () {
    if (process.env.NODE_ENV !== 'development') {
      return []
    }
    return [
      {
        source: '/api/:path*',
        destination: 'http://mirakc:40772/api/:path*'
      }
    ]
  },
  webpack: (config, { webpack }) => {
    const experiments = config.experiments || {}
    config.experiments = {
      ...experiments,
      asyncWebAssembly: true,
      syncWebAssembly: true
    }
    config.output.webassemblyModuleFilename = 'static/wasm/[modulehash].wasm'
    // config.output.assetModuleFilename = `static/[hash][ext]`
    // config.output.publicPath = `/_next/`
    // config.module.rules.push({
    //   test: /\.wasm$/,
    //   // type: 'webassembly/async'
    //   loader: 'raw-loader'
    // })
    return config
  },
  reactStrictMode: true
}
