import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Png, type Image } from '../src/driver/png.ts'
import { Screenshots } from '../src/driver/screenshot.ts'

const FIXTURES = join(import.meta.dir, 'fixtures/png')

function image(width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number, number]): Image {
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4)
  return { width, height, data }
}

describe('Png', () => {
  test('decodes every colour type, bit depth, filter, palette transparency, key colour and Adam7 interlacing as ImageMagick does', () => {
    const pngs = readdirSync(FIXTURES).filter((f) => f.endsWith('.png'))
    expect(pngs.length).toBeGreaterThan(20)
    for (const file of pngs) {
      const expected = readFileSync(join(FIXTURES, `${file.replace(/(-interlaced)?\.png$/, '')}.rgba`))
      const decoded = Png.decode(readFileSync(join(FIXTURES, file)))
      expect([file, decoded.width, decoded.height]).toEqual([file, 9, 7])
      expect([file, Buffer.from(decoded.data).equals(expected)]).toEqual([file, true])
    }
  })

  test('encodes RGBA that decodes back unchanged; refuses what is not a PNG', () => {
    const original = image(13, 5, (x, y) => [(x * 37) & 255, (y * 91) & 255, (x * y) & 255, (x + y * 13) & 255])
    const png = Png.encode(original)
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(Png.same(Png.decode(png), original)).toBe(true)
    expect(() => Png.decode(Buffer.from('not a png'))).toThrow('not a PNG file')
    expect(() => Png.encode({ width: 2, height: 2, data: new Uint8Array(3) })).toThrow('needs 16 bytes')
  })

  test('crop, fill and same', () => {
    const base = image(4, 3, (x, y) => [x * 10, y * 10, 0, 255])
    const cropped = Png.crop(base, 1, 1, 2, 2)
    expect([cropped.width, cropped.height, ...cropped.data.subarray(0, 4)]).toEqual([2, 2, 10, 10, 0, 255])
    expect(Png.crop(base, 3, 2, 10, 10).width).toBe(1)
    const filled = Png.fill(base, 0.5, 0, 1, 1, [1, 2, 3, 4])
    expect([...filled.data.subarray(0, 8)]).toEqual([1, 2, 3, 4, 1, 2, 3, 4])
    expect(Png.same(base, base)).toBe(true)
    expect(Png.same(base, filled)).toBe(false)
  })

  test('diff counts pixels past the colour threshold, leaves anti-aliased edges out, and draws what differs in red', () => {
    const white = image(10, 10, () => [255, 255, 255, 255])
    const changed = Png.fill(white, 2, 2, 3, 3, [0, 0, 0, 255])
    const diff = Png.diff(changed, white)
    expect(diff.pixels).toBe(9)
    expect([...diff.image.data.subarray((2 * 10 + 2) * 4, (2 * 10 + 2) * 4 + 4)]).toEqual([255, 0, 0, 255])
    expect(Png.diff(Png.fill(white, 0, 0, 1, 1, [250, 250, 250, 255]), white).pixels).toBe(0)
    expect(Png.diff(Png.fill(white, 0, 0, 1, 1, [200, 200, 200, 255]), white, { threshold: 0 }).pixels).toBe(1)
    const edge = (shade: number) => image(10, 10, (x) => (x < 5 ? [0, 0, 0, 255] : x === 5 ? [shade, shade, shade, 255] : [255, 255, 255, 255]))
    expect(Png.diff(edge(90), edge(170)).pixels).toBe(0)
    expect(Png.diff(edge(90), edge(170), { antialiasing: true }).pixels).toBe(10)
    expect(() => Png.diff(white, image(9, 10, () => [0, 0, 0, 255]))).toThrow('the sizes differ: 10×10 against 9×10')
  })

  test('animate: one PNG with every frame of the same size (APNG), the first as the default image', () => {
    const frame = (rgba: [number, number, number, number]) => Png.encode({ width: 3, height: 2, data: new Uint8Array(Array.from({ length: 6 }, () => rgba).flat()) })
    const big = Png.encode({ width: 4, height: 4, data: new Uint8Array(64) })
    const apng = Png.animate([{ png: frame([255, 0, 0, 255]), ms: 100 }, { png: big, ms: 50 }, { png: frame([0, 0, 255, 255]), ms: 250 }])
    const chunks = Png.chunks(apng)
    const actl = chunks.find((c) => c.type === 'acTL')!.data
    expect(actl.readUInt32BE(0)).toBe(2)
    expect(chunks.filter((c) => c.type === 'fcTL').map((c) => c.data.readUInt16BE(20))).toEqual([100, 250])
    expect(chunks.filter((c) => c.type === 'fdAT').map((c) => c.data.readUInt32BE(0))).toEqual([2])
    const first = Png.decode(apng)
    expect([first.width, first.height, ...first.data.slice(0, 4)]).toEqual([3, 2, 255, 0, 0, 255])
  })
})

describe('Screenshots.within', () => {
  const picture = image(8, 6, (x, y) => [x * 10, y * 10, 0, 255])

  test('cuts a rect given in logical pixels at the picture\'s scale, from where the picture sits', () => {
    const cut = Screenshots.within(picture, [100, 50, 4, 3], [101, 51, 2, 1], 'w1.4')
    expect([cut.width, cut.height, ...cut.data.slice(0, 4)]).toEqual([4, 2, 20, 20, 0, 255])
    expect(Screenshots.within(picture, [0, 0, 8, 6], [0, 0, 8, 6], 'all').data).toEqual(picture.data)
  })

  test('a rect off the picture or reaching past its edge is an error that says where both are', () => {
    expect(() => Screenshots.within(picture, [0, 0, 8, 6], [20, 20, 2, 2], 'w1.4')).toThrow('w1.4 (20,20,2,2) is outside the picture (0,0,8,6)')
    expect(() => Screenshots.within(picture, [0, 0, 8, 6], [6, 4, 4, 4], '--rect 6,4,4,4')).toThrow('reaches past the picture')
    expect(() => Screenshots.within(picture, [0, 0, 8, 6], [1, 1, 0, 2], 'flat')).toThrow('has no size')
  })

  test('reads X,Y,W,H and refuses the rest', () => {
    expect(Screenshots.rect('1, 2.5,30,40')).toEqual([1, 2.5, 30, 40])
    for (const bad of ['1,2,3', '1,2,0,4', 'a,b,c,d', '1,2,3,-4']) expect(Screenshots.rect(bad)).toBeNull()
  })
})
