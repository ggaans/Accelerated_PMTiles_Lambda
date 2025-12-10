1. Plumbing and helpers

Near the top of the bundle there are a lot of:

low-level DEFLATE / gzip inflate code

generic HTTP handlers

utility functions for querystring, URL escaping, etc.

PMTiles core library (index decoding, directory traversal, tile ID mapping, compression handling, etc.)

This is all the bundled dependency code from the PMTiles JS library and AWS SDK v3, not something you’d normally write by hand.

You can think of it as:

“PMTiles reader + HTTP client + gzip support, all bundled for Node.js”

2. PMTiles library glue

Key concepts in the middle of the file:

PMTiles class (re):
Implements:

getHeader() – reads the pmtiles header (tile type, zoom range, bounds, compression, etc.).

getZxy(z, x, y) – finds the tile in the compact index, range-requests from the underlying source, and decompresses if needed.

getTileJson(url) – builds a TileJSON object from header + metadata.

Directory/index logic:
Code that:

Parses the PMTiles root and leaf directories (ye, tt, etc.).

Maps (z, x, y) ↔ tile IDs (Xe, Fr).

Supports internal/tile compression enums (Y for compression type, S for tile type).

Caching layer:

SharedPromiseCache / ResolvedValueCache (Kr, st):
LRU-style cache for:

headers

directory entries
This avoids repeatedly re-reading the same index blocks for hot tiles.

3. Node/S3-specific source implementation

This is where it becomes Lambda-specific:

S3 client
const ri = new S3Client({
  requestHandler: new NodeHttpHandler({ connectionTimeout: 500, socketTimeout: 500 })
});


This is an AWS SDK v3 S3Client with a custom Node HTTP handler tuned for short timeouts.

S3 “source” for PMTiles
class _e {
  constructor(archiveName) { this.archiveName = archiveName; }

  getKey() { return this.archiveName; }

  async getBytes(offset, length, signal, etag) {
    const res = await ri.send(new GetObjectCommand({
      Bucket: process.env.BUCKET,
      Key: ut(this.archiveName, process.env.PMTILES_PATH),
      Range: "bytes="+offset+"-"+(offset+length-1),
      IfMatch: etag,
      RequestPayer: "requester"
    }));
    ...
    return {
      data: buffer,
      etag: res.ETag,
      expires: res.Expires?.toISOString(),
      cacheControl: res.CacheControl
    };
  }
}


Uses:

BUCKET env var for the S3 bucket.

PMTILES_PATH env var (optional) to build the key pattern (e.g. {name}.pmtiles or {name}/{name}.pmtiles).

Range requests for byte-serving into the PMTiles archive.

RequestPayer: "requester" – supports requester pays buckets.

So for archive name foo, it range-reads from s3://$BUCKET/<PMTILES_PATH with {name}=>foo>.

Decompression

Node-side decompression for PMTiles’ internal compression:

async function or(buf, compression) {
  if (compression === Y.None || compression === Y.Unknown) return buf;
  if (compression === Y.Gzip) return zlib.gunzipSync(buf);
  throw new Error("Compression method not supported");
}


Used by the PMTiles cache and tile reading code.

4. URL parsing and routing

Two regular expressions define the API shape:

const Wr = /^\/(?<NAME>[0-9a-zA-Z\/!\-_\.\*\'\(\)]+)\/(?<Z>\d+)\/(?<X>\d+)\/(?<Y>\d+).(?<EXT>[a-z]+)$/;
const Vr = /^\/(?<NAME>[0-9a-zA-Z\/!\-_\.\*\'\(\)]+).json$/;


A helper ct(path) function:

Matches:

/tilesetName/z/x/y.ext → { ok: true, name, tile: [z,x,y], ext }

/tilesetName.json → { ok: true, name, ext: "json" }

Returns { ok: false, ... } for anything else → 400.

It supports two Lambda event shapes:

Lambda Function URL
Uses event.rawPath.

API Gateway proxy integration
Uses event.pathParameters.proxy (and sets i = true to later decide on gzip/compression path).

If it can’t find a path, it returns 500 Invalid event configuration.

5. Core Lambda handler

At the bottom:

const R = (status, body, isBase64 = false, headers = {}) => ({
  statusCode: status,
  body,
  headers,
  isBase64Encoded: isBase64
});

const sr = async (event, postProcess) => { ... }
const ii = async (event, ctx) => await sr(event, ctx);
module.exports.handler = ii;

High-level flow inside sr:

Determine the path:

If pathParameters.proxy exists → use that ("/" + proxy"), mark i = true.

Else use rawPath.

CORS header:

If process.env.CORS is set, adds:

headers['Access-Control-Allow-Origin'] = process.env.CORS;


Parse the path:

const { ok, name, tile, ext } = ct(path);

If !ok → 400 "Invalid tile URL".

Build PMTiles reader:

const source = new _e(name);

const pm = new PMTiles(source, sharedCache, or);

Get header:

const header = await pm.getHeader();

Contains tile type, zoom range, bounds, etc.

TileJSON requests (/name.json):

When tile is empty (no z/x/y):

Requires hostname:

Either PUBLIC_HOSTNAME env var

Or CloudFront viewer-request function sets x-distribution-domain-name, passed in event.headers['x-distribution-domain-name'].

Builds URL:
https://<PUBLIC_HOSTNAME or distributionDomain>/<name>

Calls pm.getTileJson(baseURL) and returns JSON with Content-Type: application/json.

Tile requests (/name/z/x/y.ext):

Check zoom in range:

if (z < header.minZoom || z > header.maxZoom) return 404;


Check extension vs archive tile type:

Accepts:

MVT → .mvt (and .pbf is allowed special case).

PNG → .png

JPEG → .jpg

WEBP → .webp

AVIF → .avif

Rejects mismatched combos with 400 explaining requested vs archive type.

Fetch tile data:

const tileData = await pm.getZxy(z, x, y);


If no tile → 204 empty.

Set Content-Type based on header.tileType.

Optional post-processor:
If a postProcess function was passed into sr (your r arg), it can transform the raw tile bytes before returning (e.g. custom filter/transform, though in this template it’s just passed through in handler).

Cache headers:

headers["Cache-Control"] = process.env.CACHE_CONTROL || "public, max-age=86400";
headers["ETag"] = '"' + sha256(tileBytes) + '"';


Encode response:

Always base64-encodes the tile body (Lambda proxy requires that for binary).

If the request came via API Gateway/proxy (i === true), it additionally:

zlib.gzipSync on the tile bytes.

Sets Content-Encoding: gzip.

6. How it ties back to the template

Putting it all together:

LambdaFunction:

Runs this JS code on Node.js 22 (arm64).

Reads from the S3 bucket (BUCKET) with only s3:GetObject permissions.

Optional env:

PUBLIC_HOSTNAME – used for TileJSON URLs.

PMTILES_PATH – pattern for pmtiles keys.

CORS, CACHE_CONTROL – for headers.

LambdaFunctionUrl:

Exposes the Lambda over HTTPS (used as CloudFront origin).

ViewerRequestCloudFrontFunction:

Injects x-distribution-domain-name header so the Lambda can build the right TileJSON URLs when PUBLIC_HOSTNAME is not set.

CloudFront:

Points to the Lambda Function URL as origin.

Uses your cache policy, response headers (CORS), and optional hostname rewrite.

TL;DR

The code block is:

A fully embedded PMTiles server that:

Parses request paths into {archiveName, z, x, y} or archiveName.json.

Range-reads the corresponding .pmtiles file from S3 using AWS SDK v3.

Uses the PMTiles index to locate and decompress the tile.

Validates tile zoom/type/ext.

Returns:

TileJSON for /name.json, with correct hostname.

Vector or raster tiles for /name/z/x/y.ext, with:

proper Content-Type

Cache-Control, ETag, optional gzip

CORS if configured.
