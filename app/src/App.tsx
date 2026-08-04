import { useEffect } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import * as services from './services';
import './index.css';
import './ui/app2.css';
import { ToastProvider } from './ui/components/Toast';
import { InventoriesPage } from './ui/routes/InventoriesPage';
import { InventoryHomePage } from './ui/routes/InventoryHomePage';
import { ItemSheetPage } from './ui/routes/ItemSheetPage';
import { JoinPage } from './ui/routes/JoinPage';
import { ListViewPage } from './ui/routes/ListViewPage';
import { NewItemPage } from './ui/routes/NewItemPage';
import { RestorePage } from './ui/routes/RestorePage';
import { SettingsPage } from './ui/routes/SettingsPage';
import { StatsPage } from './ui/routes/StatsPage';

/**
 * HashRouter is mandatory: share links are `#/join/...` fragments so a static
 * host (and an offline-opened page) resolves every deep link without a server.
 */
export default function App() {
  useEffect(() => {
    void services.ensureRates();
  }, []);

  return (
    <ToastProvider>
      <HashRouter>
        <div className="app">
          <Routes>
            <Route path="/" element={<InventoriesPage />} />

            <Route path="/join/:docId/:token" element={<JoinPage />} />
            <Route path="/join/:docId/:token/i/:itemId" element={<JoinPage />} />
            <Route path="/join/:docId/:token/l/:dotIds" element={<JoinPage />} />
            <Route path="/join/:docId/:token/sl/:listId" element={<JoinPage />} />
            {/* E2E share links carry the content key as /k/<key> in the fragment. */}
            <Route path="/join/:docId/:token/k/:key" element={<JoinPage />} />
            <Route path="/join/:docId/:token/k/:key/i/:itemId" element={<JoinPage />} />
            <Route path="/join/:docId/:token/k/:key/l/:dotIds" element={<JoinPage />} />
            <Route path="/join/:docId/:token/k/:key/sl/:listId" element={<JoinPage />} />
            <Route path="/restore/:payload" element={<RestorePage />} />

            <Route path="/inv/:docId" element={<InventoryHomePage />} />
            <Route path="/inv/:docId/new" element={<NewItemPage />} />
            <Route path="/inv/:docId/settings" element={<SettingsPage />} />
            <Route path="/inv/:docId/stats" element={<StatsPage />} />
            <Route path="/inv/:docId/i/:itemId" element={<ItemSheetPage />} />
            <Route path="/inv/:docId/l/:dotIds" element={<ListViewPage />} />
            <Route path="/inv/:docId/sl/:listId" element={<ListViewPage />} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </HashRouter>
    </ToastProvider>
  );
}
