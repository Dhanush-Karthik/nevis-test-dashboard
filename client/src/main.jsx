import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import PopoutApp from './PopoutApp.jsx';
import { isPopout } from './popout.js';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isPopout() ? <PopoutApp /> : <App />}
  </React.StrictMode>
);
