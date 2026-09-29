#import "specs/mod.typ": mitex-scope
#let mitex-wasm = plugin("./mitex.wasm")
#let reject-math-image(..args) = panic("公式中不支持图片，请使用 Markdown 附件")
#let reject-math-code(..args) = panic("公式中不支持文件读取、代码求值或文档查询")
#let safe-mitex-scope = mitex-scope + (
  image: reject-math-image,
  read: reject-math-code,
  plugin: reject-math-code,
  eval: reject-math-code,
  query: reject-math-code,
  csv: reject-math-code,
  json: reject-math-code,
  yaml: reject-math-code,
  toml: reject-math-code,
  xml: reject-math-code,
  cbor: reject-math-code,
  bibliography: reject-math-code,
  std: (:),
  sys: (:),
)

#let get-elem-text(it) = {
  {
    if type(it) == str {
      it
    } else if type(it) == content and it.has("text") {
      it.text
    } else {
      panic("Unsupported type: " + str(type(it)))
    }
  }
}

#let mitex-convert(it, mode: "math", spec: bytes(())) = {
  let source = get-elem-text(it)
  if source.contains("\\includegraphics") { reject-math-image() }
  let converted = if mode == "math" {
    str(mitex-wasm.convert_math(bytes(source), spec))
  } else {
    str(mitex-wasm.convert_text(bytes(source), spec))
  }
  if converted.contains(regex("#image\\s*\\(")) { reject-math-image() }
  converted
}

// Math Mode
#let mimath(it, block: true, ..args) = {
  let res = mitex-convert(mode: "math", it)
  let eval-res = eval("$" + res + "$", scope: safe-mitex-scope)
  math.equation(block: block, eval-res, ..args)
}

// Text Mode
#let mitext(it) = {
  let res = mitex-convert(mode: "text", it)
  eval(res, mode: "markup", scope: safe-mitex-scope)
}

#let mitex(it, mode: "math", ..args) = {
  if mode == "math" {
    mimath(it, ..args)
  } else {
    mitext(it, ..args)
  }
}

#let mi = mimath.with(block: false)
