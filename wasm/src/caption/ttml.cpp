#include "ttml.hpp"

#include <optional>
#include <variant>

#include "ttml/parser.h"
#include "ttml/resolver.h"

using emscripten::val;
namespace ttml = arib::ttml;

namespace {

// ミリ秒 → 秒。未指定は undefined。
val toSeconds(const std::optional<std::chrono::milliseconds> &ms) {
  if (!ms) {
    return val::undefined();
  }
  return val(static_cast<double>(ms->count()) / 1000.0);
}

val toColor(const std::optional<ttml::StyleColorValue> &color) {
  if (!color) {
    return val::undefined();
  }
  val out = val::array();
  for (uint8_t c : color->rgba) {
    out.call<void>("push", static_cast<int>(c));
  }
  return out;
}

val toPair(const std::optional<ttml::LengthPair> &pair) {
  if (!pair) {
    return val::undefined();
  }
  val out = val::array();
  out.call<void>("push", pair->x);
  out.call<void>("push", pair->y);
  return out;
}

template <typename T> void setIf(val &obj, const char *key, const T &value) {
  if (value) {
    obj.set(key, *value);
  }
}

val toStyle(const ttml::StyleProperties &style) {
  val out = val::object();
  if (style.background_color) {
    out.set("backgroundColor", toColor(style.background_color));
  }
  if (style.color) {
    out.set("color", toColor(style.color));
  }
  if (style.origin) {
    out.set("origin", toPair(style.origin));
  }
  if (style.extent) {
    out.set("extent", toPair(style.extent));
  }
  if (style.font_size) {
    out.set("fontSize", toPair(style.font_size));
  }
  setIf(out, "fontFamily", style.font_family);
  if (style.font_style) {
    out.set("fontStyle", *style.font_style == ttml::StyleFontStyleValue::Italic
                             ? "italic"
                             : "normal");
  }
  if (style.font_weight) {
    out.set("fontWeight", *style.font_weight == ttml::StyleFontWeightValue::Bold
                              ? "bold"
                              : "normal");
  }
  if (style.line_height) {
    // normal は null、数値は px。
    if (const auto *px = std::get_if<double>(&*style.line_height)) {
      out.set("lineHeight", *px);
    } else {
      out.set("lineHeight", val::null());
    }
  }
  if (style.text_decoration) {
    out.set("underline", *style.text_decoration ==
                             ttml::StyleTextDecorationValue::Underline);
  }
  if (style.text_outline) {
    if (const auto *outline =
            std::get_if<ttml::TextOutline>(&*style.text_outline)) {
      val o = val::object();
      if (outline->color) {
        o.set("color", toColor(outline->color));
      }
      o.set("width", outline->border_width);
      o.set("blur", outline->blur_width);
      out.set("textOutline", o);
    }
  }
  if (style.writing_mode) {
    out.set("writingMode",
            *style.writing_mode == ttml::StyleWritingModeValue::Tbrl ? "tbrl"
                                                                     : "lrtb");
  }
  setIf(out, "letterSpacing", style.letter_spacing);
  setIf(out, "ruby", style.ruby);
  setIf(out, "borderTop", style.border_top);
  setIf(out, "borderRight", style.border_right);
  setIf(out, "borderBottom", style.border_bottom);
  setIf(out, "borderLeft", style.border_left);
  setIf(out, "flashing", style.flashing);
  return out;
}

val toTiming(const ttml::resolved::Timing &timing, val out) {
  out.set("begin", toSeconds(timing.begin));
  out.set("end", toSeconds(timing.end));
  return out;
}

val toRegion(const std::optional<ttml::resolved::Region> &region) {
  if (!region) {
    return val::undefined();
  }
  val out = val::object();
  out.set("id", region->id);
  out.set("style", toStyle(region->style));
  return out;
}

} // namespace

val parseTtml(const std::string &xml, bool ignoreTiming) {
  val result = val::object();
  // ARIB-TTML の字幕(closed caption)は同期型。
  const auto mode = ttml::SyncMode::Sync;
  auto parsed = ttml::parse(xml, mode, ignoreTiming);
  if (parsed.has_error() || !parsed.document) {
    result.set("error", parsed.error ? parsed.error->message : "parse failed");
    return result;
  }
  auto resolved = ttml::resolve(*parsed.document, mode);
  if (resolved.has_error() || !resolved.document) {
    result.set("error",
               resolved.error ? resolved.error->message : "resolve failed");
    return result;
  }

  val paragraphs = val::array();
  if (const auto &division = resolved.document->division) {
    toTiming(division->timing, result);
    for (const auto &paragraph : division->paragraphs) {
      val p = toTiming(paragraph.timing, val::object());
      p.set("region", toRegion(paragraph.region));
      p.set("style", toStyle(paragraph.style));
      val spans = val::array();
      for (const auto &span : paragraph.spans) {
        val s = toTiming(span.timing, val::object());
        s.set("style", toStyle(span.style));
        if (span.region) {
          s.set("region", toRegion(span.region));
        }
        // 文字列はそのまま、<br/> は null。
        val content = val::array();
        for (const auto &item : span.content) {
          if (const auto *text = std::get_if<std::string>(&item)) {
            content.call<void>("push", *text);
          } else {
            content.call<void>("push", val::null());
          }
        }
        s.set("content", content);
        spans.call<void>("push", s);
      }
      p.set("spans", spans);
      paragraphs.call<void>("push", p);
    }
  }
  result.set("paragraphs", paragraphs);
  return result;
}
