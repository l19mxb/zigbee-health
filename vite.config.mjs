import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],server:{host:'127.0.0.1',port:18921,strictPort:true,proxy:{'/api':'http://127.0.0.1:18920'}},build:{outDir:'dist'}});
