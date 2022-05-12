import BaseObject from 'ol/Object.js'
import Event from 'ol/events/Event.js'

import potpack from 'potpack'

import { loadImage } from './textures'
import WarpedMapEventType from './WarpedMapEventType'

export class WarpedMapRendererEvent extends Event {
  constructor(type, data) {
    super(type)

    this.data = data
  }
}

export class WarpedMapWebGLRenderer extends BaseObject {
  gl: WebGL2RenderingContext
  program: WebGLProgram
  mapId: string
  imageWidth: number
  imageHeight: number
  triangles: Float32Array
  vao: WebGLVertexArrayObject | null

  visible: boolean = false

  currentScaleFactor?: number = undefined
  previousScaleFactor?: number = undefined

  currentScaleFactorTiles: Map<string, any> = new Map()
  previousScaleFactorTiles: Map<string, any> = new Map()

  tilesTexture: WebGLTexture | null
  scaleFactorsTexture: WebGLTexture | null
  tilePositionsTexture: WebGLTexture | null
  imagePositionsTexture: WebGLTexture | null

  constructor(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    mapId: string,
    { image, transformer, triangles }
  ) {
    super()

    this.gl = gl
    this.program = program
    this.mapId = mapId
    this.imageWidth = image.width
    this.imageHeight = image.height
    this.transformer = transformer
    this.triangles = triangles

    this.tilesTexture = gl.createTexture()
    this.scaleFactorsTexture = gl.createTexture()
    this.tilePositionsTexture = gl.createTexture()
    this.imagePositionsTexture = gl.createTexture()

    this.vao = gl.createVertexArray()
    gl.bindVertexArray(this.vao)

    if (this.vao) {
      this.createBuffer(gl, program, triangles, 2, 'a_position')

      const colors = Array.from({ length: (triangles.length / 2) * 3 }, () => Math.random())
      this.createBuffer(gl, program, colors, 3, 'a_color')
    }
  }

  addTileNeeded(url: string, tile, imageRequest) {
    const scaleFactor = tile.zoomLevel.scaleFactor

    if (this.currentScaleFactor !== scaleFactor) {
      this.previousScaleFactor = this.currentScaleFactor
      this.currentScaleFactor = scaleFactor
    }

    if (!this.currentScaleFactorTiles.has(url)) {
      this.currentScaleFactorTiles.set(url, {
        tile,
        imageRequest,
        loading: true,
        image: undefined,
        imageData: undefined
      })

      this.loadTile(url, scaleFactor)
    }
  }

  deleteTileNeeded(url: string) {
    // const tile = this.currentScaleFactorTiles.get(url)
    // if (tile) {
    //   console.log(tile.loading, tile.image)
    // }

    // this.currentScaleFactorTiles.set(url, {
    //   tile,
    //   imageRequest,
    //   loading: true,
    //   image: undefined,
    // TODO: cancel tileLoading
    this.currentScaleFactorTiles.delete(url)
  }

  createBuffer(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    data,
    size: number,
    name: string
  ) {
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW)

    const type = gl.FLOAT
    const normalize = false
    const stride = 0
    const offset = 0

    const positionAttributeLocation = gl.getAttribLocation(program, name)
    gl.vertexAttribPointer(positionAttributeLocation, size, type, normalize, stride, offset)
    gl.enableVertexAttribArray(positionAttributeLocation)
  }

  async setTileImage(url: string, scaleFactor: number, image: HTMLImageElement) {
    // TODO: check currentScaleFactor === scaleFactor
    const tile = this.currentScaleFactorTiles.get(url)
    if (tile) {
      tile.loading = false
      tile.image = image

      tile.imageBitmap = await createImageBitmap(image)

      this.dispatchEvent(new WarpedMapRendererEvent(WarpedMapEventType.TILELOADED, url))
      // const canvas = document.createElement('canvas')
      // const context = canvas.getContext('2d')

      // canvas.width = image.width
      // canvas.height = image.height
      // context.drawImage(image, 0, 0)
      // tile.imageData = context.getImageData(0, 0, image.width, image.height)
    }

    this.updateTextures()
  }

  updateTextures() {
    const gl = this.gl

    const tilesForTexture = []
    for (let tile of this.currentScaleFactorTiles.values()) {
      if (!tile.loading) {
        tilesForTexture.push(tile)
      }
    }

    const tilesForTextureCount = tilesForTexture.length

    // if (tilesForTextureCount === 0) {
    //   return
    // } else if (tilesForTextureCount > MAX_TILES) {
    //   throw new Error('too many tiles')
    // }

    const scaleFactors = tilesForTexture.map((tile) => tile.tile.zoomLevel.scaleFactor)

    gl.bindTexture(gl.TEXTURE_2D, this.scaleFactorsTexture)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R32I,
      1,
      tilesForTextureCount,
      0,
      gl.RED_INTEGER,
      gl.INT,
      new Int32Array(scaleFactors)
    )

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    const packedTiles = tilesForTexture.map((tile, index) => ({
      w: tile.image.width,
      h: tile.image.height,
      index
    }))

    // Potpack modifies the tiles array and overwrites the x, y row/column
    // values with the texture position in pixel values
    const { w: textureWidth, h: textureHeight } = potpack(packedTiles)

    // if (Math.max(textureWidth, textureHeight) > MAX_TEXTURE_SIZE) {
    //   throw new Error('tile texture too large')
    // }

    gl.bindTexture(gl.TEXTURE_2D, this.tilesTexture)
    // gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, textureWidth, textureHeight)

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      textureWidth,
      textureHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null
    )

    // console.log(textureWidth, textureHeight)

    packedTiles.forEach((packedTile, index) => {
      const tileImageBitmap = tilesForTexture[index].imageBitmap

      const textureX = packedTile.x
      const textureY = packedTile.y

      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        textureX,
        textureY,
        tileImageBitmap.width,
        tileImageBitmap.height,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        tileImageBitmap
      )
    })

    const tilePositions = packedTiles.map((packedTile) => [packedTile.x, packedTile.y])

    gl.bindTexture(gl.TEXTURE_2D, this.tilePositionsTexture)
    // gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4 * 2)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RG32I,
      1,
      tilesForTextureCount,
      0,
      gl.RG_INTEGER,
      gl.INT,
      new Int32Array(tilePositions.flat())
    )

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    const imagePositions = tilesForTexture.map((tile) => [
      tile.imageRequest.region.x,
      tile.imageRequest.region.y,
      tile.imageRequest.region.width,
      tile.imageRequest.region.height
    ])

    gl.bindTexture(gl.TEXTURE_2D, this.imagePositionsTexture)
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGB32I,
      1,
      tilesForTextureCount,
      0,
      gl.RGB_INTEGER,
      gl.INT,
      new Int32Array(imagePositions.flat())
    )

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  async loadTile(url: string, scaleFactor: number) {
    let tileImage: HTMLImageElement | undefined

    try {
      tileImage = await loadImage(url)
    } catch (err) {
      this.dispatchEvent(new WarpedMapRendererEvent(WarpedMapEventType.TILELOADINGERROR, url))
    }

    if (tileImage) {
      this.setTileImage(url, scaleFactor, tileImage)
    } else {
      this.dispatchEvent(new WarpedMapRendererEvent(WarpedMapEventType.TILELOADINGERROR, url))
    }
  }
}
