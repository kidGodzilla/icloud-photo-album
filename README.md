# iCloud Photo Album Viewer

A simple Express server that fetches and displays iCloud shared photo albums with a beautiful, responsive interface. Perfect for embedding photo albums in your website or viewing them standalone.

## Features

- 🖼️ **Beautiful Grid View** - Responsive photo grid with hover effects
- 🔍 **Full-Screen Lightbox** - Click any photo to view in full-screen modal with instant thumbnail preview
- ⌨️ **Keyboard Navigation** - Arrow keys to navigate, ESC to close
- 📱 **Mobile Support** - Swipe gestures (left/right for navigation, down to dismiss) and touch-friendly interface
- 🌙 **Dark Mode** - Automatically adapts to system preferences
- 🚀 **Smart Caching** - Disk-based caching with stale-while-revalidate for instant loads
- 🔒 **Privacy & Security** - EXIF location data stripped from images, token encryption support
- 🎬 **Video Support** - View videos alongside photos in the gallery
- 🎨 **Embeddable Modal** - Easy-to-use script for embedding albums in any webpage
- 📅 **Smart Sorting** - Photos sorted by date (newest first)
- ⚡ **Image Optimization** - Automatic resizing and compression for faster loading

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file (optional):

```env
PORT=3000
CACHE_TTL=7200000              # Cache TTL in milliseconds (default: 2 hours)
CACHE_DIR=./cache              # Cache directory (default: ./cache)
ENCRYPTION_SECRET=your-secret  # Secret for token encryption (required for production)
MAX_IMAGE_WIDTH=1920           # Maximum image width in pixels (default: 1920)
MAX_IMAGE_HEIGHT=1920          # Maximum image height in pixels (default: 1920)
IMAGE_QUALITY=85               # JPEG quality 0-100 (default: 85)
```

## Usage

### Start the Server

```bash
npm start
```

The server will run on `http://localhost:3000` (or the PORT specified in your `.env`).

### View an Album

Access albums by their token in the URL:

```
http://localhost:3000/B1v532ODWVjCzg
```

Or use the query parameter (backwards compatible):

```
http://localhost:3000/?token=B1v532ODWVjCzg
```

### API Endpoints

#### `GET /api/album/:token`

Fetches album data from iCloud and returns JSON. Supports both plain tokens and encrypted tokens (prefixed with `e-`).

**Response:**
```json
{
  "metadata": { ... },
  "photos": [ ... ],
  "reloading": false  // true if serving stale cache while refreshing
}
```

#### `POST /api/encrypt-token`

Encrypts a public album token into a private encrypted token.

**Request:**
```json
{
  "token": "B1v532ODWVjCzg"
}
```

**Response:**
```json
{
  "encryptedToken": "e-abc123..."
}
```

#### `GET /api/image/:secureId.jpg`

Proxies images with EXIF location data stripped and optimized for web display. Images are cached with proper headers for browser caching.

## Embedding in Your Website

Include the modal script and call it with an album token:

```html
<script src="https://your-domain.com/icloud-photo-album-modal.js"></script>
<a href="#" onclick="icloudAlbumModal('B1v532ODWVjCzg'); return false;">View Photos</a>
```

Or with a button:

```html
<script src="https://your-domain.com/icloud-photo-album-modal.js"></script>
<button onclick="icloudAlbumModal('B1v532ODWVjCzg')">Open Album</button>
```

### Modal Features

- **Full-screen overlay** with smooth fade animations
- **Close button** (top right) - automatically hides when lightbox is open
- **Click outside** to close
- **ESC key** to close (works even when iframe has focus)
- **Isolated styles** - won't conflict with your page styles
- **Responsive** - works great on mobile and desktop

## Project Structure

```
icloud-photo-album/
├── index.js                    # Express server
├── package.json
├── public/
│   ├── index.html              # Main album viewer page
│   ├── icloud-photo-album-modal.js  # Embeddable modal script
│   └── test.html               # Test page for modal
└── .env                        # Environment variables (optional)
```

## API Routes

### `GET /api/album/:token`

Fetches album data from iCloud and returns JSON.

**Response:**
```json
{
  "metadata": {
    "userFirstName": "James",
    "userLastName": "Futhey",
    "streamName": "Published"
  },
  "photos": [
    {
      "photoGuid": "...",
      "dateCreated": "2025-12-18T05:48:09.000Z",
      "caption": "Photo caption",
      "derivatives": {
        "257": { "url": "...", "width": 342, "height": 257 },
        "1537": { "url": "...", "width": 2049, "height": 1537 }
      }
    }
  ]
}
```

### `GET /:albumId`

Serves the album viewer page for the given album ID.

### Static Files

All files in the `public/` directory are served statically.

## Caching

Album data and processed images are cached on disk for persistence across server restarts. The caching system uses a **stale-while-revalidate** strategy:

- **Fresh cache**: Served immediately
- **Stale cache**: Served immediately while fresh data loads in the background
- **Cache location**: `./cache/` directory (configurable via `CACHE_DIR`)

Cache structure:
- `cache/albums/` - Album JSON data
- `cache/images/` - Processed images (EXIF stripped, optimized)
- `cache/mappings/` - Secure ID to original URL mappings

Cache entries expire after the configured TTL (default: 2 hours). Images are cached with proper HTTP headers for browser caching.

## Keyboard Shortcuts

- **Arrow Left/Right** - Navigate between photos in lightbox
- **ESC** - Close lightbox or modal
- **Click outside** - Close lightbox or modal

## Mobile Gestures

- **Swipe left** - Next photo
- **Swipe right** - Previous photo
- **Swipe down** - Close lightbox or modal

## Browser Support

Works in all modern browsers that support:
- ES6+ JavaScript
- CSS Grid
- Flexbox
- PostMessage API

## Privacy & Security

- **EXIF Stripping**: All GPS/location data is automatically removed from images
- **Token Encryption**: Convert public tokens to encrypted private tokens (prefixed with `e-`)
- **Secure Image URLs**: Original iCloud URLs are never exposed to clients
- **Location Data Removal**: Location metadata is stripped from album JSON responses

## Image Optimization

Images are automatically optimized for web display:
- Resized to maximum dimensions (default: 1920x1920px)
- JPEG quality optimized (default: 85%)
- Progressive JPEG encoding
- Proper cache headers for browser caching

## Development

The project uses:
- **Express 5** - Web server
- **icloud-shared-album** - Fetches album data from iCloud
- **sharp** - Image processing and EXIF stripping
- **simple-encryptor** - Token encryption
- **dotenv** - Environment variable management

## License

ISC


