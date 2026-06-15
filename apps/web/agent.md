# Agent: OpenMemory Web Interface

## Overview
The `@openmemory/web` application is the React-based frontend for the OpenMemory system. It provides a visual interface for users to interact with their cognitive memory (Genome and Phenotype), monitor memory patterns, and manage their OpenMemory data.

## Functionality
- **Dashboard**: Visualizes memory statistics and usage patterns.
- **Memory Exploration**: Provides tools to browse and interact with stored coding context.
- **User Interface**: A modern, responsive web UI built with React, Vite, and Tailwind CSS.
- **Backend Integration**: Connects to the OpenMemory backend API to fetch and manage cognitive data.

## Getting Started

### Prerequisites
- Node.js (LTS recommended)
- npm or yarn

### Installation
```bash
cd apps/web
npm install
```

### Development Mode
To start the development server with hot module replacement (HMR):
```bash
npm run dev
```
The application will be available at `http://localhost:5173` (default Vite port).

### Build for Production
To create an optimized production build:
```bash
npm run build
```
The build artifacts will be generated in the `dist/` directory.

### Preview Production Build
To test the production build locally:
```bash
npm run preview
```

## Technical Stack
- **Framework**: React 18
- **Build Tool**: Vite
- **Language**: TypeScript
- **Styling**: Tailwind CSS & PostCSS
- **Icons**: Lucide React
