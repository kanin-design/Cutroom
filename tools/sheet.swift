// Draws a labelled grid of images (a contact sheet) with CoreGraphics and CoreText.
// Reads a JSON spec on stdin and writes a JPEG. Built on demand by lib/media.js:
//   swiftc -O tools/sheet.swift -o tools/.bin/sheet
//
// Also: `sheet --check-xml` < file checks that a sketch is well-formed XML.
//
// spec: { out, cols, tileWidth, aspect, title?, subtitle?,
//         tiles: [{ image?, num?, title, meta?, text?, color?, marks?: [{x, y, label}] }] }
// A tile without an image is drawn as a storyboard card from its title and text.

import AppKit
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Mark: Decodable { let x: Double; let y: Double; let label: String }
struct Tile: Decodable {
  let image: String?; let num: String?; let title: String
  let meta: String?; let text: String?; let color: String?; let marks: [Mark]?
  let caption: String?   // printed under the tile (the scene's picture and sound text)
}
struct Spec: Decodable {
  let out: String; let cols: Int; let tileWidth: Double; let aspect: Double
  let title: String?; let subtitle: String?; let tiles: [Tile]
  let captionLines: Int?  // room under each tile for this many lines of caption
}

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(1)
}

// `sheet --check-xml`: is stdin well-formed XML? Prints the first error with its line and column.
if CommandLine.arguments.dropFirst().first == "--check-xml" {
  final class Catcher: NSObject, XMLParserDelegate { var err: Error? ; func parser(_ p: XMLParser, parseErrorOccurred e: Error) { if err == nil { err = e } } }
  let parser = XMLParser(data: FileHandle.standardInput.readDataToEndOfFile())
  let c = Catcher()
  parser.delegate = c
  if parser.parse() { exit(0) }
  fail("\(parser.lineNumber):\(parser.columnNumber):\((c.err as NSError?)?.code ?? 0)")
}

let spec: Spec
do { spec = try JSONDecoder().decode(Spec.self, from: FileHandle.standardInput.readDataToEndOfFile()) } catch { fail("bad spec: \(error)") }

func color(_ hex: String, _ a: CGFloat = 1) -> CGColor {
  var v: UInt64 = 0
  Scanner(string: hex.replacingOccurrences(of: "#", with: "")).scanHexInt64(&v)
  return CGColor(srgbRed: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: a)
}

let sans = NSFont.systemFont(ofSize: 17, weight: .semibold)
let body = NSFont.systemFont(ofSize: 13.5, weight: .regular)
let mono = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
let serifDesc = NSFont.systemFont(ofSize: 34).fontDescriptor.withDesign(.serif)?.withSymbolicTraits(.italic)
let serif = serifDesc.flatMap { NSFont(descriptor: $0, size: 34) } ?? NSFont.systemFont(ofSize: 34)
let headFont = NSFont.systemFont(ofSize: 24, weight: .semibold)

let pad = 32.0, gap = 22.0
let captionH = Double(spec.captionLines ?? 0) * 19.0 + (spec.captionLines ?? 0 > 0 ? 8 : 0)
let labelH = 58.0 + captionH
let tw = spec.tileWidth, th = (spec.tileWidth / spec.aspect).rounded()
let cols = max(1, min(spec.cols, spec.tiles.count))
let rows = Int(ceil(Double(spec.tiles.count) / Double(cols)))
let headerH = spec.title == nil ? 0.0 : 64.0
let W = pad * 2 + Double(cols) * tw + Double(cols - 1) * gap
let H = pad * 2 + headerH + Double(rows) * (th + labelH) + Double(max(0, rows - 1)) * gap

guard let ctx = CGContext(data: nil, width: Int(W), height: Int(H), bitsPerComponent: 8, bytesPerRow: 0,
                          space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
else { fail("no context") }
// Work top-down, like a page.
ctx.translateBy(x: 0, y: H)
ctx.scaleBy(x: 1, y: -1)
ctx.setFillColor(color("#0b0b0d"))
ctx.fill(CGRect(x: 0, y: 0, width: W, height: H))

func attr(_ s: String, _ font: NSFont, _ c: CGColor) -> NSAttributedString {
  NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: NSColor(cgColor: c) ?? .white])
}

// One line of text with its baseline at y, clipped to maxW with an ellipsis.
func line(_ s: String, _ font: NSFont, _ c: CGColor, x: Double, y: Double, maxW: Double) -> Double {
  var l = CTLineCreateWithAttributedString(attr(s, font, c))
  if CTLineGetTypographicBounds(l, nil, nil, nil) > maxW,
     let t = CTLineCreateTruncatedLine(l, maxW, .end, CTLineCreateWithAttributedString(attr("…", font, c))) { l = t }
  ctx.saveGState()
  ctx.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
  ctx.textPosition = CGPoint(x: x, y: y)
  CTLineDraw(l, ctx)
  ctx.restoreGState()
  return CTLineGetTypographicBounds(l, nil, nil, nil)
}

// Wrapped text inside rect, top-aligned; lines that don't fit are dropped.
func paragraph(_ s: String, _ font: NSFont, _ c: CGColor, _ r: CGRect) {
  let fs = CTFramesetterCreateWithAttributedString(attr(s, font, c))
  let frame = CTFramesetterCreateFrame(fs, CFRange(location: 0, length: 0), CGPath(rect: CGRect(origin: .zero, size: r.size), transform: nil), nil)
  ctx.saveGState()
  ctx.translateBy(x: r.minX, y: r.maxY)
  ctx.scaleBy(x: 1, y: -1)
  ctx.textMatrix = .identity
  CTFrameDraw(frame, ctx)
  ctx.restoreGState()
}

func loadImage(_ path: String) -> CGImage? {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil) else { return nil }
  return CGImageSourceCreateImageAtIndex(src, 0, nil)
}

// Aspect-fill an image into r (the context is flipped, so flip the image back).
func draw(_ img: CGImage, in r: CGRect) {
  let s = max(r.width / Double(img.width), r.height / Double(img.height))
  let w = Double(img.width) * s, h = Double(img.height) * s
  let f = CGRect(x: r.midX - w / 2, y: r.midY - h / 2, width: w, height: h)
  ctx.saveGState()
  ctx.clip(to: r)
  ctx.translateBy(x: 0, y: f.minY + f.maxY)
  ctx.scaleBy(x: 1, y: -1)
  ctx.interpolationQuality = .high
  ctx.draw(img, in: f)
  ctx.restoreGState()
}

if let t = spec.title {
  _ = line(t, headFont, color("#ecebe8"), x: pad, y: pad + 24, maxW: W - pad * 2)
  if let sub = spec.subtitle { _ = line(sub, mono, color("#86858c"), x: pad, y: pad + 48, maxW: W - pad * 2) }
}

for (i, t) in spec.tiles.enumerated() {
  let c = i % cols, r = i / cols
  let x = pad + Double(c) * (tw + gap)
  let y = pad + headerH + Double(r) * (th + labelH + gap)
  let rect = CGRect(x: x, y: y, width: tw, height: th)
  let rounded = CGPath(roundedRect: rect, cornerWidth: 6, cornerHeight: 6, transform: nil)

  ctx.saveGState()
  ctx.addPath(rounded)
  ctx.clip()
  if let p = t.image, let img = loadImage(p) {
    ctx.setFillColor(color("#000000"))
    ctx.fill(rect)
    draw(img, in: rect)
  } else {
    // A storyboard card: the scene's colour as a faint wash, its title and what we should see.
    ctx.setFillColor(color("#141418"))
    ctx.fill(rect)
    ctx.setFillColor(color(t.color ?? "#8b8f98", 0.13))
    ctx.fill(rect)
    let inset = tw * 0.07
    _ = line("NO RENDER YET", mono, color("#86858c"), x: x + inset, y: y + inset + 8, maxW: tw - inset * 2)
    _ = line(t.title, serif, color("#ecebe8"), x: x + inset, y: y + inset + 50, maxW: tw - inset * 2)
    if let text = t.text, !text.isEmpty {
      paragraph(text, body, color("#b9b8bd"), CGRect(x: x + inset, y: y + inset + 66, width: tw - inset * 2, height: th - inset * 2 - 66))
    }
  }
  for m in t.marks ?? [] {
    let px = x + m.x * tw, py = y + m.y * th
    ctx.setFillColor(color("#ff5b35"))
    ctx.fillEllipse(in: CGRect(x: px - 11, y: py - 11, width: 22, height: 22))
    let lw = CTLineGetTypographicBounds(CTLineCreateWithAttributedString(attr(m.label, mono, color("#ffffff"))), nil, nil, nil)
    _ = line(m.label, mono, color("#ffffff"), x: px - lw / 2, y: py + 4, maxW: 40)
  }
  ctx.restoreGState()
  ctx.addPath(rounded)
  ctx.setStrokeColor(color("#ffffff", 0.08))
  ctx.setLineWidth(1)
  ctx.strokePath()

  var lx = x
  if let c = t.color {
    ctx.setFillColor(color(c))
    ctx.fillEllipse(in: CGRect(x: lx, y: y + th + 13, width: 10, height: 10))
    lx += 18
  }
  if let n = t.num { lx += line(n, mono, color("#86858c"), x: lx, y: y + th + 24, maxW: 40) + 8 }
  _ = line(t.title, sans, color("#ecebe8"), x: lx, y: y + th + 25, maxW: x + tw - lx)
  if let m = t.meta { _ = line(m, mono, color("#86858c"), x: x, y: y + th + 46, maxW: tw) }
  if let cap = t.caption, !cap.isEmpty, captionH > 0 {
    paragraph(cap, NSFont.systemFont(ofSize: 13.5), color("#b9b8bd"), CGRect(x: x, y: y + th + 58, width: tw, height: captionH))
  }
}

guard let img = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: spec.out) as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
else { fail("can't write \(spec.out)") }
CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: 0.86] as CFDictionary)
if !CGImageDestinationFinalize(dest) { fail("can't write \(spec.out)") }
