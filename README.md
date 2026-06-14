# vrm-to-video

Streams a Victron VRM dashboard embed page as an **RTSP video feed**, so any NVR can treat it like a camera.

## Architecture

```
[Puppeteer/Chromium] → screenshot every N seconds
        ↓ PNG frames via stdin pipe
[ffmpeg] → H.264 encode
        ↓ RTSP push
[mediamtx] → RTSP server
        ↓
[NVR / VLC / any RTSP client]
```

## Quick start

```bash
git clone https://github.com/Sebaf-26/my-vrm-to-video
cd my-vrm-to-video
docker compose up -d
```

NVR stream URL:
```
rtsp://<HOST_IP>:8554/victron
```

## Deploy on Portainer

1. In Portainer → **Stacks** → **Add stack**
2. Choose **Repository** and point to this repo (or paste the `docker-compose.yml`)
3. Deploy

## Environment variables (screenshotter service)

| Variable | Default | Description |
|---|---|---|
| `VRM_URL` | *(your embed URL)* | The VRM embed page to capture |
| `RTSP_URL` | `rtsp://mediamtx:8554/victron` | Internal RTSP push target |
| `INTERVAL_MS` | `5000` | Milliseconds between frames |
| `WIDTH` | `1280` | Viewport / stream width |
| `HEIGHT` | `800` | Viewport / stream height |
| `WAIT_AFTER_LOAD` | `8000` | ms to wait for JS to render on first load |

## Watch in browser (WebRTC)

mediamtx also exposes a WebRTC player at:
```
http://<HOST_IP>:8888/victron
```

## Ports

| Port | Protocol | Use |
|---|---|---|
| 8554 | TCP | RTSP — point NVR here |
| 8888 | TCP | WebRTC viewer |
