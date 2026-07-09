// MUST be first: sets window.CESIUM_BASE_URL before Cesium initializes.
import './cesium-base';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import './ui/styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
