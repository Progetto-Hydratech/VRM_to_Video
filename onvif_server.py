#!/usr/bin/env python3
"""
Minimal ONVIF server for UniFi Protect discovery.
Implements WS-Discovery (UDP 3702) + ONVIF Device/Media service (HTTP).
"""
import os, socket, struct, threading, textwrap
from http.server import HTTPServer, BaseHTTPRequestHandler
from uuid import uuid4

HOST_IP   = os.environ.get('ONVIF_SERVER_IP', '192.168.1.112')
RTSP_IP   = os.environ.get('RTSP_SERVER_IP',  '192.168.1.112')
RTSP_PORT = os.environ.get('RTSP_PORT',        '8554')
RTSP_PATH = os.environ.get('RTSP_PATH',        'victron')
ONVIF_PORT= int(os.environ.get('ONVIF_PORT', '8090'))
DEVICE_NAME=os.environ.get('DEVICE_NAME',      'Victron VRM')
DEVICE_UUID= str(uuid4())

RTSP_URL  = f"rtsp://{RTSP_IP}:{RTSP_PORT}/{RTSP_PATH}"
ONVIF_URL = f"http://{HOST_IP}:{ONVIF_PORT}/onvif/device_service"

WSD_MCAST = '239.255.255.250'
WSD_PORT  = 3702

# ── WS-Discovery ─────────────────────────────────────────────────────────────
PROBE_MATCH = textwrap.dedent(f"""\
<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope
  xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
  xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing"
  xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery"
  xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <SOAP-ENV:Header>
    <wsa:MessageID>urn:uuid:{uuid4()}</wsa:MessageID>
    <wsa:RelatesTo>REPLACEME</wsa:RelatesTo>
    <wsa:To>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:To>
    <wsa:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches</wsa:Action>
  </SOAP-ENV:Header>
  <SOAP-ENV:Body>
    <wsd:ProbeMatches>
      <wsd:ProbeMatch>
        <wsa:EndpointReference>
          <wsa:Address>urn:uuid:{DEVICE_UUID}</wsa:Address>
        </wsa:EndpointReference>
        <wsd:Types>dn:NetworkVideoTransmitter</wsd:Types>
        <wsd:Scopes>
          onvif://www.onvif.org/type/video_encoder
          onvif://www.onvif.org/name/{DEVICE_NAME.replace(' ','%20')}
          onvif://www.onvif.org/location/
        </wsd:Scopes>
        <wsd:XAddrs>{ONVIF_URL}</wsd:XAddrs>
        <wsd:MetadataVersion>1</wsd:MetadataVersion>
      </wsd:ProbeMatch>
    </wsd:ProbeMatches>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>""")

def wsd_listener():
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(('', WSD_PORT))
    mreq = struct.pack('4s4s', socket.inet_aton(WSD_MCAST), socket.inet_aton('0.0.0.0'))
    sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
    print(f'[WS-Discovery] listening on UDP {WSD_PORT}', flush=True)
    while True:
        data, addr = sock.recvfrom(4096)
        msg = data.decode('utf-8', errors='ignore')
        if 'Probe' in msg and 'ProbeMatch' not in msg:
            # extract MessageID to put in RelatesTo
            msg_id = ''
            for line in msg.splitlines():
                if 'MessageID' in line:
                    start = line.find('>') + 1
                    end = line.rfind('<')
                    msg_id = line[start:end]
                    break
            reply = PROBE_MATCH.replace('REPLACEME', msg_id)
            sock.sendto(reply.encode(), addr)
            print(f'[WS-Discovery] replied to {addr[0]}', flush=True)

# ── ONVIF HTTP ────────────────────────────────────────────────────────────────
def soap_response(body):
    return textwrap.dedent(f"""\
<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope
  xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope"
  xmlns:tds="http://www.onvif.org/ver10/device/wsdl"
  xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
  xmlns:tt="http://www.onvif.org/ver10/schema">
  <SOAP-ENV:Body>{body}</SOAP-ENV:Body>
</SOAP-ENV:Envelope>""")

HTTPServer.allow_reuse_address = True

class ONVIFHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f'[ONVIF HTTP] {fmt % args}', flush=True)

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length).decode('utf-8', errors='ignore')

        if 'GetDeviceInformation' in body:
            resp = soap_response(f"""
<tds:GetDeviceInformationResponse>
  <tds:Manufacturer>Victron</tds:Manufacturer>
  <tds:Model>{DEVICE_NAME}</tds:Model>
  <tds:FirmwareVersion>1.0</tds:FirmwareVersion>
  <tds:SerialNumber>{DEVICE_UUID}</tds:SerialNumber>
  <tds:HardwareId>1.0</tds:HardwareId>
</tds:GetDeviceInformationResponse>""")

        elif 'GetCapabilities' in body or 'GetServices' in body:
            resp = soap_response(f"""
<tds:GetCapabilitiesResponse>
  <tds:Capabilities>
    <tt:Media><tt:XAddr>http://{HOST_IP}:{ONVIF_PORT}/onvif/media_service</tt:XAddr></tt:Media>
  </tds:Capabilities>
</tds:GetCapabilitiesResponse>""")

        elif 'GetProfiles' in body:
            resp = soap_response(f"""
<trt:GetProfilesResponse>
  <trt:Profiles token="profile1" fixed="true">
    <tt:Name>{DEVICE_NAME}</tt:Name>
    <tt:VideoEncoderConfiguration token="vec1">
      <tt:Name>H264</tt:Name>
      <tt:Encoding>H264</tt:Encoding>
      <tt:Resolution><tt:Width>1280</tt:Width><tt:Height>800</tt:Height></tt:Resolution>
    </tt:VideoEncoderConfiguration>
  </trt:Profiles>
</trt:GetProfilesResponse>""")

        elif 'GetStreamUri' in body:
            resp = soap_response(f"""
<trt:GetStreamUriResponse>
  <trt:MediaUri>
    <tt:Uri>{RTSP_URL}</tt:Uri>
    <tt:InvalidAfterConnect>false</tt:InvalidAfterConnect>
    <tt:InvalidAfterReboot>false</tt:InvalidAfterReboot>
    <tt:Timeout>PT0S</tt:Timeout>
  </trt:MediaUri>
</trt:GetStreamUriResponse>""")

        elif 'GetSystemDateAndTime' in body:
            from datetime import datetime, timezone
            now = datetime.now(timezone.utc)
            resp = soap_response(f"""
<tds:GetSystemDateAndTimeResponse>
  <tds:SystemDateAndTime>
    <tt:DateTimeType>NTP</tt:DateTimeType>
    <tt:UTCDateTime>
      <tt:Time><tt:Hour>{now.hour}</tt:Hour><tt:Minute>{now.minute}</tt:Minute><tt:Second>{now.second}</tt:Second></tt:Time>
      <tt:Date><tt:Year>{now.year}</tt:Year><tt:Month>{now.month}</tt:Month><tt:Day>{now.day}</tt:Day></tt:Date>
    </tt:UTCDateTime>
  </tds:SystemDateAndTime>
</tds:GetSystemDateAndTimeResponse>""")

        else:
            resp = soap_response('<tds:GetDeviceInformationResponse/>')

        encoded = resp.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/soap+xml; charset=utf-8')
        self.send_header('Content-Length', len(encoded))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ONVIF server running')

if __name__ == '__main__':
    print(f'[ONVIF] Device: {DEVICE_NAME}  UUID: {DEVICE_UUID}', flush=True)
    print(f'[ONVIF] RTSP: {RTSP_URL}', flush=True)
    print(f'[ONVIF] HTTP: {ONVIF_URL}', flush=True)
    threading.Thread(target=wsd_listener, daemon=True).start()
    server = HTTPServer(('0.0.0.0', ONVIF_PORT), ONVIFHandler)
    print(f'[ONVIF] HTTP server on port {ONVIF_PORT}', flush=True)
    server.serve_forever()