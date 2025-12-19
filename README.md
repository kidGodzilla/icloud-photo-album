# iCloud Photo Album Viewer

A simple Express server that fetches and displays iCloud shared photo albums with a beautiful, responsive interface. Perfect for embedding photo albums in your website or viewing them standalone.

## Features

- 🖼️ **Beautiful Grid View** - Responsive photo grid with hover effects
- 🔍 **Full-Screen Lightbox** - Click any photo to view in full-screen modal
- ⌨️ **Keyboard Navigation** - Arrow keys to navigate, ESC to close
- 📱 **Mobile Support** - Swipe gestures and touch-friendly interface
- 🌙 **Dark Mode** - Automatically adapts to system preferences
- 🚀 **Fast Caching** - In-memory cache for faster repeated album loads
- 🎨 **Embeddable Modal** - Easy-to-use script for embedding albums in any webpage
- 📅 **Smart Sorting** - Photos sorted by date (newest first)

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file (optional):

```env
PORT=3000
CACHE_TTL=3600000  # Cache TTL in milliseconds (default: 1 hour)
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

### API Endpoint

Fetch album data directly:

```
GET /api/album/:token
```

Returns JSON data with album metadata and photos.

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

Album data is cached in memory to improve performance. Cache entries expire after the configured TTL (default: 1 hour). The cache is cleared when the server restarts.

## Keyboard Shortcuts

- **Arrow Left/Right** - Navigate between photos in lightbox
- **ESC** - Close lightbox or modal
- **Click outside** - Close lightbox or modal

## Mobile Gestures

- **Swipe left** - Next photo
- **Swipe right** - Previous photo

## Browser Support

Works in all modern browsers that support:
- ES6+ JavaScript
- CSS Grid
- Flexbox
- PostMessage API

## Development

The project uses:
- **Express 5** - Web server
- **icloud-shared-album** - Fetches album data from iCloud
- **dotenv** - Environment variable management

## License

ISC

