package dev.raph.inventory;

import android.util.Log;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;
import org.json.JSONArray;
import org.json.JSONObject;

import java.net.InetSocketAddress;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Minimal y-webrtc signaling server, a direct port of server/src/signaling.ts:
 * JSON messages {type: subscribe|unsubscribe, topics: [...]}, {type: publish,
 * topic, ...} broadcast to the topic's subscribers (with a `clients` count),
 * and {type: ping} answered with {type: pong}.
 *
 * Privacy: topic names are HMAC-derived room ids and published payloads are
 * encrypted with the room password (both derived from the doc's E2E key), so
 * a stranger on the LAN connecting here learns nothing about documents.
 */
class LanSignalingServer extends WebSocketServer {
    private static final String TAG = "LanSignaling";
    private static final int MAX_TOPICS_PER_CONN = 64;
    private static final int MAX_MESSAGE_CHARS = 64 * 1024;

    private final Map<String, Set<WebSocket>> topics = new HashMap<>();
    private final Map<WebSocket, Set<String>> subscriptions = new HashMap<>();
    private final CountDownLatch started = new CountDownLatch(1);

    LanSignalingServer() {
        // Port 0: the OS picks a free port; NSD advertises the real one.
        super(new InetSocketAddress("0.0.0.0", 0));
        setReuseAddr(true);
        // Keep idle phone connections alive (ws-level ping every 30s).
        setConnectionLostTimeout(30);
    }

    /** Blocks until the server socket is bound; returns the bound port. */
    int startAndGetPort() throws InterruptedException {
        start();
        if (!started.await(5, TimeUnit.SECONDS)) {
            throw new InterruptedException("LAN signaling server did not start in time");
        }
        return getPort();
    }

    @Override
    public void onStart() {
        started.countDown();
        Log.i(TAG, "listening on port " + getPort());
    }

    @Override
    public synchronized void onOpen(WebSocket conn, ClientHandshake handshake) {
        subscriptions.put(conn, new HashSet<>());
    }

    @Override
    public synchronized void onClose(WebSocket conn, int code, String reason, boolean remote) {
        Set<String> subscribed = subscriptions.remove(conn);
        if (subscribed == null) return;
        for (String topic : subscribed) {
            Set<WebSocket> subs = topics.get(topic);
            if (subs != null) {
                subs.remove(conn);
                if (subs.isEmpty()) topics.remove(topic);
            }
        }
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        Log.w(TAG, "socket error", ex);
    }

    @Override
    public synchronized void onMessage(WebSocket conn, String message) {
        if (message == null || message.length() > MAX_MESSAGE_CHARS) return;
        JSONObject msg;
        try {
            msg = new JSONObject(message);
        } catch (Exception e) {
            return;
        }
        String type = msg.optString("type", "");
        Set<String> subscribed = subscriptions.get(conn);
        if (subscribed == null) return;

        switch (type) {
            case "subscribe": {
                JSONArray list = msg.optJSONArray("topics");
                if (list == null) break;
                for (int i = 0; i < list.length(); i++) {
                    String topic = list.optString(i, null);
                    if (topic == null || topic.length() > 512) continue;
                    if (subscribed.size() >= MAX_TOPICS_PER_CONN) break;
                    Set<WebSocket> subs = topics.get(topic);
                    if (subs == null) {
                        subs = new HashSet<>();
                        topics.put(topic, subs);
                    }
                    subs.add(conn);
                    subscribed.add(topic);
                }
                break;
            }
            case "unsubscribe": {
                JSONArray list = msg.optJSONArray("topics");
                if (list == null) break;
                for (int i = 0; i < list.length(); i++) {
                    String topic = list.optString(i, null);
                    if (topic == null) continue;
                    Set<WebSocket> subs = topics.get(topic);
                    if (subs != null) {
                        subs.remove(conn);
                        if (subs.isEmpty()) topics.remove(topic);
                    }
                    subscribed.remove(topic);
                }
                break;
            }
            case "publish": {
                String topic = msg.optString("topic", null);
                if (topic == null) break;
                Set<WebSocket> receivers = topics.get(topic);
                if (receivers == null) break;
                try {
                    msg.put("clients", receivers.size());
                } catch (Exception ignored) {
                }
                String out = msg.toString();
                Iterator<WebSocket> it = receivers.iterator();
                while (it.hasNext()) {
                    WebSocket receiver = it.next();
                    try {
                        if (receiver.isOpen()) receiver.send(out);
                    } catch (Exception e) {
                        it.remove();
                    }
                }
                break;
            }
            case "ping": {
                try {
                    conn.send("{\"type\":\"pong\"}");
                } catch (Exception ignored) {
                }
                break;
            }
            default:
                break;
        }
    }
}
