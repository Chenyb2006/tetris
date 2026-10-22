import AppKit

guard CommandLine.arguments.count == 2 else { fatalError("Usage: Icon.swift output.png") }
let size = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
NSGraphicsContext.current?.imageInterpolation = .none
NSColor(calibratedRed: 0.045, green: 0.068, blue: 0.075, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 40, y: 40, width: 944, height: 944), xRadius: 192, yRadius: 192).fill()

let colors = [
    NSColor(calibratedRed: 0.72, green: 0.93, blue: 0.39, alpha: 1),
    NSColor(calibratedRed: 0.34, green: 0.79, blue: 0.82, alpha: 1),
    NSColor(calibratedRed: 0.96, green: 0.64, blue: 0.32, alpha: 1)
]
let cells = [(0,0,1),(1,0,1),(2,0,1),(2,1,1),(0,1,0),(1,1,0),(1,2,0),(2,2,0),(3,0,2),(3,1,2),(3,2,2),(2,3,2)]
for (column, row, colorIndex) in cells {
    let rect = NSRect(x: 206 + column * 154, y: 218 + row * 154, width: 138, height: 138)
    colors[colorIndex].setFill()
    NSBezierPath(rect: rect).fill()
    NSColor(white: 1, alpha: 0.18).setFill()
    NSBezierPath(rect: NSRect(x: rect.minX, y: rect.maxY - 12, width: rect.width, height: 12)).fill()
    NSColor(white: 0, alpha: 0.2).setFill()
    NSBezierPath(rect: NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: 12)).fill()
}
image.unlockFocus()
guard let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let data = bitmap.representation(using: .png, properties: [:]) else { fatalError("Could not render icon") }
try data.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
