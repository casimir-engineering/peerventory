package dev.raph.inventory;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LanDiscoveryPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
