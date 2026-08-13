import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Admin root element is missing');
createRoot(root).render(<StrictMode><App /></StrictMode>);
