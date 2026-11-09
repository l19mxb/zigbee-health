import React,{Suspense,lazy} from 'react';
import {createRoot} from 'react-dom/client';
import './styles.css';
import './fit.css';
const kiosk=window.location.pathname==='/kiosk'||window.location.pathname==='/kiosk/';
const Surface=lazy(()=>kiosk?import('./kiosk.jsx'):Promise.all([import('./App.jsx'),import('./pwa.js')]).then(([app])=>app));
createRoot(document.getElementById('root')).render(<React.StrictMode><Suspense fallback={<main className="loading-page"><p>{kiosk?'Opening local keypad…':'Opening Zigbee Console…'}</p></main>}><Surface/></Suspense></React.StrictMode>);
