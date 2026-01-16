const { Resvg } = require('@resvg/resvg-js')
const sharp = require('sharp')
const fs = require('fs')
const path = require('path')

const svgPath = path.join(__dirname, '../build/icon.svg')
const svgContent = fs.readFileSync(svgPath, 'utf8')

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

async function generateIcons() {
  console.log('Generating icons from SVG...')

  const pngBuffers = {}

  for (const size of sizes) {
    const resvg = new Resvg(svgContent, {
      fitTo: {
        mode: 'width',
        value: size
      },
      shapeRendering: 2, // crispEdges for small sizes
      textRendering: 1,
      imageRendering: 0 // optimizeQuality
    })

    const pngData = resvg.render()
    let pngBuffer = pngData.asPng()

    // For small icons, apply sharpening to improve clarity
    if (size <= 64) {
      pngBuffer = await sharp(pngBuffer)
        .sharpen({ sigma: 0.5 })
        .png({ quality: 100, compressionLevel: 9 })
        .toBuffer()
    }

    pngBuffers[size] = pngBuffer

    const outputPath = path.join(__dirname, `../build/icon-${size}.png`)
    fs.writeFileSync(outputPath, pngBuffer)
    console.log(`  Created: icon-${size}.png`)
  }

  // Copy 256 as the main icon.png
  fs.copyFileSync(
    path.join(__dirname, '../build/icon-256.png'),
    path.join(__dirname, '../build/icon.png')
  )
  console.log('  Created: icon.png (256x256)')

  // Generate Windows .ico file with multiple sizes embedded
  await generateIco(pngBuffers)

  console.log('Done! Icons generated in build/ folder')
}

async function generateIco(pngBuffers) {
  // ICO format: https://en.wikipedia.org/wiki/ICO_(file_format)
  // Sizes to embed in ICO (Windows uses these)
  const icoSizes = [16, 24, 32, 48, 64, 128, 256]
  const images = []

  for (const size of icoSizes) {
    if (pngBuffers[size]) {
      images.push({
        size,
        buffer: pngBuffers[size]
      })
    }
  }

  // Build ICO file
  const iconDir = Buffer.alloc(6 + images.length * 16)
  iconDir.writeUInt16LE(0, 0)      // Reserved
  iconDir.writeUInt16LE(1, 2)      // Type: 1 = ICO
  iconDir.writeUInt16LE(images.length, 4) // Number of images

  let offset = 6 + images.length * 16
  const imageBuffers = []

  for (let i = 0; i < images.length; i++) {
    const img = images[i]
    const entryOffset = 6 + i * 16

    // Convert PNG to raw RGBA for ICO, or use PNG directly (modern ICO supports PNG)
    const pngBuffer = img.buffer

    iconDir.writeUInt8(img.size >= 256 ? 0 : img.size, entryOffset)     // Width (0 = 256)
    iconDir.writeUInt8(img.size >= 256 ? 0 : img.size, entryOffset + 1) // Height
    iconDir.writeUInt8(0, entryOffset + 2)         // Color palette
    iconDir.writeUInt8(0, entryOffset + 3)         // Reserved
    iconDir.writeUInt16LE(1, entryOffset + 4)      // Color planes
    iconDir.writeUInt16LE(32, entryOffset + 6)     // Bits per pixel
    iconDir.writeUInt32LE(pngBuffer.length, entryOffset + 8)  // Size of image data
    iconDir.writeUInt32LE(offset, entryOffset + 12)           // Offset to image data

    offset += pngBuffer.length
    imageBuffers.push(pngBuffer)
  }

  const icoBuffer = Buffer.concat([iconDir, ...imageBuffers])
  const icoPath = path.join(__dirname, '../build/icon.ico')
  fs.writeFileSync(icoPath, icoBuffer)
  console.log('  Created: icon.ico (multi-resolution)')
}

generateIcons().catch(console.error)
