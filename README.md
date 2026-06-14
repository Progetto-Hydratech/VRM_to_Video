# VRM to Video

Stream your Victron VRM energy dashboard as an RTSP H.264 camera feed — compatible with UniFi Protect and any ONVIF NVR.

![Dashboard Preview](screenshot.jpg)

## How it works

```
Victron VRM API → HTML render (Puppeteer) → PNG → ffmpeg H.264 → mediamtx RTSP → ONVIF server → UniFi Protect
```

## Requirements

- Docker + Docker Compose
- A Victron system with VRM access (API token)
- UniFi Protect or any ONVIF-compatible NVR

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/Progetto-Hydratech/VRM_to_Video.git
cd VRM_to_Video
```

### 2. Create a `.env` file

```env
VRM_TOKEN=your_vrm_api_token
VRM_SITE_ID=your_installation_id
HOST_IP=192.168.1.x        # IP of the machine running Docker
FPS=5
```

> **VRM_SITE_ID**: find it in the VRM portal URL — `vrm.victronenergy.com/installation/XXXXXX`  
> **VRM_TOKEN**: generate it in VRM → Profile → Access Tokens

### 3. Start the stack

```bash
docker compose up -d
```

### 4. Add to UniFi Protect

1. In UniFi Protect → **Add Device** → **ONVIF Camera**
2. IP: your `HOST_IP`, Port: `31472`
3. Username/Password: `admin` / `admin`

The stream will appear as a live camera feed.

## What's shown on the dashboard

| Card | Source |
|------|--------|
| Rete (Grid) | Grid meter L1 power |
| Fotovoltaico | MPPT Tracker 1 PV power |
| Consumi Casa | VE.Bus output power L1 |
| Batteria | SOC % + charge/discharge state |
| Temp. Soffitta | Temperature sensor |

## Ports

| Port | Protocol | Use |
|---|---|---|
| 8554 | TCP | RTSP — point NVR here |
| 8888 | TCP | WebRTC viewer (`http://HOST_IP:8888/victron`) |
| 31472 | TCP | ONVIF device service |

## Stack

| Service | Image |
|---------|-------|
| RTSP server | `bluenviron/mediamtx` |
| Screenshotter + ffmpeg | Custom (Node.js + Chromium) |
| ONVIF server | Custom (Python) |
