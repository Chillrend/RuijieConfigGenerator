# Ruijie Switch Config Generator & Enterprise Fleet Manager

An enterprise-grade network automation, configuration generator, and real-time telemetry fleet management platform designed specifically for Ruijie Networks hardware running RGOS (11.x and 12.x).

---

## ⚡ Key Highlights

- **Dual-Mode Telemetry (gRPC Dial-Out + SSH Fallback)**:
  - **Modern RGOS (12.x)**: Switches dial out directly over HTTP/2 gRPC (`/gnmi.sonic.gNMIDialOut/Publish`) pushing OpenConfig interface status, link state, and optical transceiver DDM metrics every 5 seconds.
  - **Legacy RGOS (11.x) / Incompatible Hardware**: Automatically falls back to isolated SSH polling commands without manual intervention or configuration drift.
- **High-Performance Architecture**:
  - **In-Memory Caching (Redis)**: Sub-millisecond port status and interface caching (`SET sw:{ip}:telemetry EX 3600`) eliminating switch polling CPU overhead.
  - **Time-Series Storage (InfluxDB v2)**: Real-time optical diagnostic monitoring (Tx/Rx dBm, temperature, voltage, bias current) with batch writes.
  - **Relational Persistence (PostgreSQL / SQLite)**: Device inventory, credentials, configuration history, and topology mappings.
  - **Push Updates (Socket.IO)**: Live WebSocket updates stream interface changes, optical telemetry, and fleet health directly into the UI without page refreshes.
- **Visual Switch Provisioner**:
  - Interactive front-panel visualizer (1G / 2.5G / 10G / 25G / 40G / 100G ports).
  - Drag-and-drop batch configuration (VLAN assignment, switchport mode, storm control, port descriptions).
  - Code 128 & DataMatrix barcode scanning integration for fast inventory onboarding.
- **Fleet Orchestration & Backup**:
  - One-click global gRPC dial-out preset deployment across hundreds of switches.
  - Automated daily running-config backups (`show running-config`) with revision tracking.

---

## 🏗️ Architecture

```
                                  ┌───────────────────────────────┐
                                  │      Ruijie Switch Fleet      │
                                  └───────┬───────────────┬───────┘
                                          │               │
        gRPC Dial-Out (OpenConfig, :50051)│               │ SSH Polling Fallback (:22)
                                          ▼               ▼
                       ┌──────────────────────┐   ┌──────────────────────┐
                       │  grpc-listener.js    │   │      poller.js       │
                       │ (HTTP/2 Dial-Out)    │   │ (SSH Engine / Queue) │
                       └──────────┬───────────┘   └──────────┬───────────┘
                                  │                          │
                                  ├───────────┐  ┌───────────┤
                                  ▼           ▼  ▼           ▼
                           ┌─────────────┐  ┌─────────────┐  ┌──────────────┐
                           │    Redis    │  │ PostgreSQL  │  │  InfluxDB v2  │
                           │(Live State) │  │ (Inventory) │  │ (Time Series)│
                           └──────┬──────┘  └──────┬──────┘  └──────────────┘
                                  │                │
                                  └───────┬────────┘
                                          ▼
                               ┌─────────────────────┐
                               │   Express API &     │
                               │   Socket.IO Server  │
                               └──────────┬──────────┘
                                          │
                                          ▼
                               ┌─────────────────────┐
                               │  Vue 3 + Tailwind   │
                               │  Single-Page App    │
                               └─────────────────────┘
```

---

## 🚀 Production Deployment (Docker Compose)

The easiest and most reliable way to run the entire stack in production is using Docker Compose.

### 1. Clone & Configure Environment

```bash
git clone https://github.com/chillrend/RuijieConfigGenerator.git
cd RuijieConfigGenerator

# Create your production environment file
cp .env.example .env
```

Edit `.env` to match your network environment:

```ini
# Web & Backend API
PORT=3001
JWT_SECRET=generate_a_secure_random_string_here
DISABLE_AUTH=false

# Google OAuth (Optional: Set DISABLE_AUTH=true to bypass during internal staging)
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_client_secret
GOOGLE_CALLBACK_URL=https://switch.yourdomain.com/api/auth/google/callback
ALLOWED_EMAILS=admin@yourdomain.com,ops@yourdomain.com

# PostgreSQL Database
DATABASE_URL=postgresql://ruijie:ruijiepass@postgres:5432/ruijiedb

# Redis & InfluxDB
REDIS_URL=redis://redis:6379
INFLUX_URL=http://influxdb:8086
INFLUX_TOKEN=ruijie-secret-fleet-token-12345
INFLUX_ORG=ruijie_fleet
INFLUX_BUCKET=switch_metrics

# gRPC Telemetry Collector
# NOTE: GRPC_COLLECTOR_IP MUST be the server IP that switches can route to
GRPC_COLLECTOR_IP=10.23.9.10
GRPC_COLLECTOR_PORT=50051
GRPC_PORT=50051
```

### 2. Launch Services

```bash
docker compose up -d --build
```

This starts:
- `ruijie-config-generator`: Production API & built Vue frontend (`http://your-server:3001`).
- `ruijie-grpc-listener`: Standalone HTTP/2 gRPC dial-out ingestion daemon (`:50051`).
- `postgres`: Persistent relational database (`:5432`).
- `redis`: In-memory port state cache and queue backend (`:6379`).
- `influxdb`: Time-series optical metrics engine (`:8086`).

### 3. Verify Health

```bash
# Check running containers
docker compose ps

# View gRPC telemetry listener logs
docker compose logs -f ruijie-grpc-listener

# View API server logs
docker compose logs -f ruijie-config-generator
```

---

## 🛠️ Bare-Metal / Local Development Setup

If you prefer running services directly on the host machine:

### Prerequisites
- Node.js >= 20.x
- Docker or native services for PostgreSQL, Redis, and InfluxDB
- `gnmic` CLI tool (installed to `/usr/local/bin/gnmic` or in `$PATH`)

### Fast Startup
Run the unified multi-process runner:

```bash
chmod +x start.sh
./start.sh
```

`start.sh` automatically checks for Docker dependencies, starts the backend (`:3001`), gRPC listener (`:50051`), and Vite dev server (`:5173`).

---

## ⚙️ Switch Configuration Guide

### 1. Modern Switches (RGOS 12.x / OpenConfig Supported)

Configure the switch to dial out to your collector server:

```text
configure terminal
grpc
 server port 50052
 rpc gnmi enable
 sensor-group FAST_METRICS
  sensor-path openconfig-interfaces:interfaces
  exit-sensor-group
 sensor-group SLOW_METRICS
  sensor-path openconfig-lldp:lldp
  sensor-path /openconfig-platform:components/component/transceiver
  exit-sensor-group
 destination-group FLEET_BACKEND
  ip <COLLECTOR_IP> port 50051
  exit-destination-group
 subscription FLEET_STREAM
  sensor-group FAST_METRICS sample-interval 5000
  sensor-group SLOW_METRICS sample-interval 60000
  destination-group FLEET_BACKEND
  exit-grpc-subscription
end
write
```

> **Tip**: You can push this snippet automatically to all eligible switches with one click from the **Global Config** modal in the Fleet Management UI.

### 2. Verification on Switch CLI

```text
show grpc openconfig subscription
```

You should see:
```text
subscription FLEET_STREAM:
  sensor group FAST_METRICS:
    sample interval: 5000
    sensor path: openconfig-interfaces:interfaces
      state: RESOLVED
      recv count: 1245
```

### 3. Legacy Switches & Fallback Notes

- **RGOS 11.x (e.g., S6250 firmware)**: Accepts the gRPC CLI syntax but does not implement OpenConfig operational telemetry paths (reports `GIVEUP`). The backend automatically recognizes this and keeps the switch on high-speed SSH scraping (`show interfaces status`).
- **RG-S5000-10GT series**: CLI lacks gRPC module support. Handled automatically via SSH polling.

---

## 🖥️ UI & Feature Walkthrough

### 1. Fleet Management Dashboard
- **IP Numerical Sorting & Pagination**: Sort switches cleanly by IPv4 address without string-sorting quirks (`10.90.1.2` before `10.90.1.10`).
- **Telemetry Indicators**: Real-time badges for **gRPC Live** (green), **SSH Fallback** (blue), and **Offline** (red).
- **Port Utilization Counters**: Live counters for operational ports (e.g., `8/57 Up`) and active uplink counts.
- **Global Config Modal**:
  - Push gRPC Dial-Out configuration to all eligible switches simultaneously.
  - Backup `show running-config` across the entire fleet in parallel with live progress tracking.

### 2. Switch Detail & Visual Faceplate
- **Interactive Visual Faceplate**: Dynamic port rendering based on model specifications (GigabitEthernet, TenGigabitEthernet, 25G, 40G, 100G).
- **Detailed Port Table**:
  - Live link state, admin status, negotiated speed, duplex.
  - VLAN assignments (Access & Trunk) with truncated display and hover tooltips for large VLAN lists.
  - Real-time optical DDM readings (Tx/Rx power in dBm, temperature, voltage) with colored health warnings.
  - Live PoE wattage consumption and power status.
- **Per-Port Fast Config**: Quick-toggle port status, change VLANs, or edit port descriptions without leaving the browser.

### 3. Visual Switch Provisioner (New Devices)
- **Visual Port Assignment**: Click-and-drag across ports to assign Access/Trunk modes and VLANs.
- **Strict Provisioning**: Captures Serial Number (S/N) and MAC address before generating configuration.
- **Barcode & DataMatrix Scanner**: Pair a smartphone via QR code to scan hardware box barcodes directly into the web form.
- **Printable Deployment Summary**: Generates clean, print-ready deployment sheets with DataMatrix inventory tags and configuration summaries.

---

## 🛠️ Hardware Models & Customization

The system comes pre-seeded with support for common Ruijie enterprise and datacenter switches:
- `RG-S6250-48XS8CQ` (48x 10G SFP+, 8x 100G QSFP28)
- `RG-S6150-48VS8CQ-X` (48x 10G/25G SFP28, 8x 100G QSFP28)
- `RG-S5350-24GT4XS-P-E` / `RG-S5350-24GT4XS-E` (24x 1G RJ45 PoE+, 4x 10G SFP+)
- `RG-S5350-12GT4XS-P-E` (12x 1G RJ45 PoE+, 4x 10G SFP+)
- `RG-S5315-24MG6XS-UP-E` (24x Multi-Gigabit PoE++, 6x 10G SFP+)
- `RG-S5000-10GT2MS-P-E` (10x 1G RJ45 PoE+, 2x 2.5G SFP)
- `RG-IS5200-24GT4XS-UP-DC` (Industrial, 24x 1G, 4x 10G SFP+)

### Adding a New Switch Model
You can define any new Ruijie switch model in `backend/data/db.json`:

```json
{
  "id": "RG-SNEW-24GT4XS",
  "portPrefix": "GigabitEthernet 0/",
  "totalPorts": 24,
  "uplinkPrefix": "TenGigabitEthernet 0/",
  "uplinkPorts": [25, 26, 27, 28]
}
```

---

## 🔒 Security & Best Practices

1. **Firewall & Routing**: Ensure switch management VLANs can reach the collector server on TCP port `50051` (gRPC Dial-Out) and that the collector can reach switches on TCP port `22` (SSH) and `50052` (gNMI Dial-In for PoE).
2. **Authentication**: Set `DISABLE_AUTH=false` and configure Google OAuth (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS`) for production environments.
3. **Database Secrets**: Never commit `.env` or `backend/data/` files to Git. All device credentials stored in PostgreSQL should use non-default administrative credentials.

---

## 📄 License

MIT License. Designed and maintained for enterprise network operations.
