package dev.raph.inventory;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;

/**
 * LAN discovery for zero-infrastructure device-to-device sync (see
 * CONTRACTS.md "LAN discovery" and app/src/store/lan.ts):
 *
 * - advertises this device as an mDNS/NSD service `_peerventory._tcp` whose
 *   TXT record carries the app's stable deviceId,
 * - browses for other Peerventory devices on the network and reports them to
 *   JS as {deviceId, host, port} via the 'peersChanged' event,
 * - runs a tiny embedded WebSocket signaling server (LanSignalingServer) that
 *   only ferries opaque room subscriptions and encrypted SDP blobs.
 *
 * Permissions: NsdManager itself requires none at runtime (NEARBY_WIFI_DEVICES
 * is for direct Wi-Fi APIs, not NSD); CHANGE_WIFI_MULTICAST_STATE +
 * ACCESS_WIFI_STATE cover the multicast lock that keeps mDNS reliable.
 */
@CapacitorPlugin(name = "LanDiscovery")
public class LanDiscoveryPlugin extends Plugin {
    private static final String TAG = "LanDiscovery";
    private static final String SERVICE_TYPE = "_peerventory._tcp.";

    private NsdManager nsdManager;
    private LanSignalingServer server;
    private WifiManager.MulticastLock multicastLock;
    private NsdManager.RegistrationListener registrationListener;
    private NsdManager.DiscoveryListener discoveryListener;

    private String deviceId = "";
    private String registeredName = null;

    /** serviceName -> resolved peer info. */
    private final Map<String, JSObject> peers = new HashMap<>();
    /** NSD resolves must run one at a time (concurrent ones fail with BUSY). */
    private final ArrayDeque<NsdServiceInfo> resolveQueue = new ArrayDeque<>();
    private boolean resolving = false;

    @PluginMethod
    public void start(PluginCall call) {
        String dev = call.getString("deviceId", "");
        if (dev == null || dev.isEmpty()) {
            call.reject("deviceId required");
            return;
        }
        synchronized (this) {
            if (server != null) {
                JSObject ret = new JSObject();
                ret.put("port", server.getPort());
                call.resolve(ret);
                return;
            }
            deviceId = dev;
            try {
                WifiManager wifi = (WifiManager) getContext()
                        .getApplicationContext()
                        .getSystemService(Context.WIFI_SERVICE);
                if (wifi != null) {
                    multicastLock = wifi.createMulticastLock("peerventory-mdns");
                    multicastLock.setReferenceCounted(false);
                    multicastLock.acquire();
                }

                server = new LanSignalingServer();
                int port = server.startAndGetPort();

                nsdManager = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
                registerService(port);
                startDiscovery();

                JSObject ret = new JSObject();
                ret.put("port", port);
                call.resolve(ret);
            } catch (Exception e) {
                Log.w(TAG, "start failed", e);
                cleanup();
                call.reject("LAN discovery failed to start: " + e.getMessage());
            }
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        synchronized (this) {
            cleanup();
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (this) {
            cleanup();
        }
    }

    /* ---------- NSD registration (advertise) ---------- */

    private void registerService(int port) {
        NsdServiceInfo info = new NsdServiceInfo();
        // The name must be unique on the network; NSD may rename on conflict
        // (onServiceRegistered reports the final name, used to skip self).
        info.setServiceName("pv-" + deviceId);
        info.setServiceType(SERVICE_TYPE);
        info.setPort(port);
        info.setAttribute("dev", deviceId);

        registrationListener = new NsdManager.RegistrationListener() {
            @Override
            public void onServiceRegistered(NsdServiceInfo nsdServiceInfo) {
                registeredName = nsdServiceInfo.getServiceName();
                Log.i(TAG, "registered as " + registeredName);
            }

            @Override
            public void onRegistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {
                Log.w(TAG, "registration failed: " + errorCode);
            }

            @Override
            public void onServiceUnregistered(NsdServiceInfo serviceInfo) {
            }

            @Override
            public void onUnregistrationFailed(NsdServiceInfo serviceInfo, int errorCode) {
            }
        };
        nsdManager.registerService(info, NsdManager.PROTOCOL_DNS_SD, registrationListener);
    }

    /* ---------- NSD discovery (browse + resolve) ---------- */

    private void startDiscovery() {
        discoveryListener = new NsdManager.DiscoveryListener() {
            @Override
            public void onDiscoveryStarted(String serviceType) {
            }

            @Override
            public void onServiceFound(NsdServiceInfo serviceInfo) {
                String name = serviceInfo.getServiceName();
                if (name == null || !name.startsWith("pv-")) return;
                if (name.equals(registeredName) || name.equals("pv-" + deviceId)) return;
                synchronized (LanDiscoveryPlugin.this) {
                    resolveQueue.add(serviceInfo);
                    drainResolveQueue();
                }
            }

            @Override
            public void onServiceLost(NsdServiceInfo serviceInfo) {
                String name = serviceInfo.getServiceName();
                synchronized (LanDiscoveryPlugin.this) {
                    if (name != null && peers.remove(name) != null) notifyPeers();
                }
            }

            @Override
            public void onDiscoveryStopped(String serviceType) {
            }

            @Override
            public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                Log.w(TAG, "discovery start failed: " + errorCode);
            }

            @Override
            public void onStopDiscoveryFailed(String serviceType, int errorCode) {
            }
        };
        nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
    }

    private void drainResolveQueue() {
        if (resolving) return;
        NsdServiceInfo next = resolveQueue.poll();
        if (next == null) return;
        resolving = true;
        nsdManager.resolveService(next, new NsdManager.ResolveListener() {
            @Override
            public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                synchronized (LanDiscoveryPlugin.this) {
                    resolving = false;
                    drainResolveQueue();
                }
            }

            @Override
            public void onServiceResolved(NsdServiceInfo serviceInfo) {
                synchronized (LanDiscoveryPlugin.this) {
                    resolving = false;
                    addResolvedPeer(serviceInfo);
                    drainResolveQueue();
                }
            }
        });
    }

    private void addResolvedPeer(NsdServiceInfo serviceInfo) {
        String name = serviceInfo.getServiceName();
        InetAddress addr = serviceInfo.getHost();
        int port = serviceInfo.getPort();
        if (name == null || addr == null || port <= 0) return;

        String dev = null;
        byte[] devAttr = serviceInfo.getAttributes() != null
                ? serviceInfo.getAttributes().get("dev")
                : null;
        if (devAttr != null) dev = new String(devAttr, StandardCharsets.UTF_8);
        if ((dev == null || dev.isEmpty()) && name.startsWith("pv-")) {
            dev = name.substring(3);
        }
        if (dev == null || dev.isEmpty() || dev.equals(deviceId)) return;

        String host = addr.getHostAddress();
        if (host == null) return;
        int scope = host.indexOf('%');
        if (scope >= 0) host = host.substring(0, scope);

        JSObject peer = new JSObject();
        peer.put("deviceId", dev);
        peer.put("host", host);
        peer.put("port", port);
        peers.put(name, peer);
        notifyPeers();
    }

    private void notifyPeers() {
        JSArray list = new JSArray();
        for (JSObject peer : peers.values()) list.put(peer);
        JSObject data = new JSObject();
        data.put("peers", list);
        notifyListeners("peersChanged", data);
    }

    /* ---------- teardown ---------- */

    private void cleanup() {
        if (nsdManager != null) {
            try {
                if (discoveryListener != null) nsdManager.stopServiceDiscovery(discoveryListener);
            } catch (Exception ignored) {
            }
            try {
                if (registrationListener != null) nsdManager.unregisterService(registrationListener);
            } catch (Exception ignored) {
            }
        }
        discoveryListener = null;
        registrationListener = null;
        registeredName = null;
        if (server != null) {
            try {
                server.stop(1000);
            } catch (Exception ignored) {
            }
            server = null;
        }
        if (multicastLock != null) {
            try {
                if (multicastLock.isHeld()) multicastLock.release();
            } catch (Exception ignored) {
            }
            multicastLock = null;
        }
        peers.clear();
        resolveQueue.clear();
        resolving = false;
    }
}
