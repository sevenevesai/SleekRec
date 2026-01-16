const { Resvg } = require('@resvg/resvg-js')
const fs = require('fs')
const path = require('path')

const svgPath = path.join(__dirname, '../build/icon.svg')
const svgContent = fs.readFileSync(svgPath, 'utf8')

const sizes = [16, 32, 48, 64, 128, 256, 512, 1024]

console.log('Generating icons from SVG...')

for (const size of sizes) {
  const resvg = new Resvg(svgContent, {
    fitTo: {
      mode: 'width',
      value: size
    }
  })

  const pngData = resvg.render()
  const pngBuffer = pngData.asPng()

  const outputPath = path.join(__dirname, `../build/icon-${size}.png`)
  fs.writeFileSync(outputPath, pngBuffer)
  console.log(`  Created: icon-${size}.png`)
}

// Copy 256 as the main icon.png for Windows/Linux
fs.copyFileSync(
  path.join(__dirname, '../build/icon-256.png'),
  path.join(__dirname, '../build/icon.png')
)
console.log('  Created: icon.png (256x256)')

console.log('Done! Icons generated in build/ folder')
