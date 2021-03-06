// TODO: consider using
// https://github.com/mourner/flatbush
import RBush from 'rbush'
import earcut from 'earcut'

import { fromLonLat } from 'ol/proj.js'
import { apply as applyTransform } from 'ol/transform.js'

import { computeIiifTilesForMapExtent } from '@allmaps/render'
import { Image as IIIFImage } from '@allmaps/iiif-parser'
import { createTransformer, polygonToWorld } from '@allmaps/transform'

import WarpedMapEventType from './WarpedMapEventType.ts'
import { WarpedMap } from './WarpedMap.ts'

interface WarpedMapsRtreeItem {
  minX: number
  minY: number
  maxX: number
  maxY: number
  mapId: string
}

const neededTilesByMap: Map<string, Map<string, any>> = new Map()
const warpedMaps: Map<string, WarpedMap> = new Map()
const warpedMapsRtree: RBush<WarpedMapsRtreeItem> = new RBush()

function getGeoMaskExtent(geoMask) {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  geoMask.coordinates[0].forEach((coordinate) => {
    minX = Math.min(minX, coordinate[0])
    minY = Math.min(minY, coordinate[1])
    maxX = Math.max(maxX, coordinate[0])
    maxY = Math.max(maxY, coordinate[1])
  })

  return {
    minX,
    minY,
    maxX,
    maxY
  }
}

function sendSourceMessage(type, data) {
  postMessage({ type, data })
}

function updateNeededTiles(mapId, image, iiifTilesForMapExtent) {
  const updatedNeededTilesForMap = new Map()
  const updatedNeededTileUrlsForMap = new Set()

  iiifTilesForMapExtent.forEach((tile) => {
    const imageRequest = image.getIiifTile(tile.zoomLevel, tile.column, tile.row)
    const url = image.getImageUrl(imageRequest)

    updatedNeededTilesForMap.set(url, {
      tile,
      imageRequest,
      url
    })

    updatedNeededTileUrlsForMap.add(url)
  })

  if (!neededTilesByMap.has(mapId)) {
    neededTilesByMap.set(mapId, new Map())
    sendSourceMessage(WarpedMapEventType.WARPEDMAPENTEREXTENT, {
      mapId
    })
  }

  const currentNeededTilesForMap = neededTilesByMap.get(mapId)

  let tilesAdded = [...updatedNeededTileUrlsForMap].filter(
    ({ url }) => !currentNeededTilesForMap.has(url)
  )

  let tilesRemoved = [...currentNeededTilesForMap.keys()].filter(
    (url) => !updatedNeededTileUrlsForMap.has(url)
  )

  if (tilesAdded.length) {
    tilesAdded.forEach((url) => {
      const neededTile = updatedNeededTilesForMap.get(url)

      sendSourceMessage(WarpedMapEventType.TILENEEDED, {
        mapId,
        ...neededTile
      })

      currentNeededTilesForMap.set(url, neededTile)
    })
  }

  if (tilesRemoved.length) {
    tilesRemoved.forEach((url) => {
      sendSourceMessage(WarpedMapEventType.TILEUNNEEDED, {
        mapId,
        url
      })

      currentNeededTilesForMap.delete(url)

      if (currentNeededTilesForMap.size === 0) {
        neededTilesByMap.delete(mapId)

        sendSourceMessage(WarpedMapEventType.WARPEDMAPLEAVEEXTENT, {
          mapId
        })
      }
    })
  }
}

onmessage = async (event: MessageEvent) => {
  const { type, data } = event.data

  if (type === WarpedMapEventType.ADDMAP) {
    const { map, mapId } = data
    const imageUri = map.image.uri

    const iiifData = await fetch(`${imageUri}/info.json`).then((response) => response.json())
    const image = IIIFImage.parse(iiifData)

    const gcps = map.gcps

    const sphericalMercatorGcps = gcps.map(({ world, image }) => ({
      world: fromLonLat(world),
      image
    }))

    const transformer = createTransformer(sphericalMercatorGcps)

    const geoMask = polygonToWorld(
      transformer,
      [...map.pixelMask, map.pixelMask[map.pixelMask.length - 1]],
      0.01,
      0
    )

    // TODO:to make sure only tiles for visible parts of the map are requested
    // (and not for parts hidden behind maps on top of it)
    // use https://github.com/mfogel/polygon-clipping to subtract geoMasks of
    // maps that have been added before.
    // Map A (topmost): show completely
    // Map B: B - A
    // Map C: C - B - A
    // Map D: D - C - B - A

    const flattened = earcut.flatten(geoMask.coordinates)
    const vertexIndices = earcut(flattened.vertices, flattened.holes, flattened.dimensions)
    const triangles = vertexIndices
      .map((index) => [flattened.vertices[index * 2], flattened.vertices[index * 2 + 1]])
      .flat()

    const geoExtent = getGeoMaskExtent(geoMask)

    const warpedMap = new WarpedMap(mapId, map, image, transformer, geoMask, geoExtent, triangles)

    warpedMaps.set(mapId, warpedMap)

    const item = {
      ...warpedMap.geoExtent,
      mapId
    }

    warpedMapsRtree.insert(item)

    sendSourceMessage(WarpedMapEventType.WARPEDMAPADDED, {
      mapId,
      image,
      transformer,
      triangles
    })
  } else if (type === WarpedMapEventType.UPDATENEEDEDTILES) {
    const { size, extent, coordinateToPixelTransform } = data
    const [minX, minY, maxX, maxY] = extent

    const rtreeResults = warpedMapsRtree.search({
      minX,
      minY,
      maxX,
      maxY
    })

    const possiblyUnneededMaps = new Set(neededTilesByMap.keys())

    if (rtreeResults.length) {
      for (let { mapId } of rtreeResults) {
        const warpedMap = warpedMaps.get(mapId)

        if (!warpedMap) {
          continue
        }

        const topLeft = [warpedMap.geoExtent.minX, warpedMap.geoExtent.minY]
        const bottomRight = [warpedMap.geoExtent.maxX, warpedMap.geoExtent.maxY]

        const pixelTopLeft = applyTransform(coordinateToPixelTransform, topLeft)
        const pixelBottomRight = applyTransform(coordinateToPixelTransform, bottomRight)

        const pixelWidth = Math.abs(pixelBottomRight[0] - pixelTopLeft[0])
        const pixelHeight = Math.abs(pixelTopLeft[1] - pixelBottomRight[1])

        // Only draw maps that are larger than 1 pixel in combined width and height
        // TODO: use constant instead of 1
        if (pixelWidth + pixelHeight < 1) {
          continue
        }

        const transformer = warpedMap.transformer
        const image = warpedMap.image
        const iiifTilesForMapExtent = computeIiifTilesForMapExtent(transformer, image, size, extent)

        updateNeededTiles(mapId, image, iiifTilesForMapExtent)
        possiblyUnneededMaps.delete(mapId)
      }
    }

    for (let mapId of possiblyUnneededMaps) {
      const neededTilesForMap = neededTilesByMap.get(mapId)
      for (let url of neededTilesForMap.keys()) {
        sendSourceMessage(WarpedMapEventType.TILEUNNEEDED, {
          mapId,
          url
        })
      }

      neededTilesByMap.delete(mapId)
      sendSourceMessage(WarpedMapEventType.WARPEDMAPLEAVEEXTENT, {
        mapId
      })
    }
  }

  // To remove data from RBush, see
  // https://github.com/mourner/rbush#removing-data
}

export {}
