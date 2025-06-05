#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import express, { Request, Response } from 'express';
import { z } from 'zod';

// Esquemas de validación
const GetWeatherArgsSchema = z.object({
  latitude: z.number().describe('Latitude coordinate'),
  longitude: z.number().describe('Longitude coordinate'),
});

const GetLocationWeatherArgsSchema = z.object({
  state: z.string().describe('US state name'),
});

// Servidor MCP
const mcpServer = new Server(
  {
    name: 'weather',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Lista de herramientas
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_weather',
        description: 'Get current weather for a location by coordinates',
        inputSchema: {
          type: 'object',
          properties: {
            latitude: {
              type: 'number',
              description: 'Latitude coordinate',
            },
            longitude: {
              type: 'number',
              description: 'Longitude coordinate',
            },
          },
          required: ['latitude', 'longitude'],
        },
      },
      {
        name: 'get_location_weather',
        description: 'Get current weather for a US state',
        inputSchema: {
          type: 'object',
          properties: {
            state: {
              type: 'string',
              description: 'US state name',
            },
          },
          required: ['state'],
        },
      },
    ],
  };
});

// Manejar llamadas a herramientas
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  switch (request.params.name) {
    case 'get_weather': {
      const args = GetWeatherArgsSchema.parse(request.params.arguments);
      const { latitude, longitude } = args;
      
      try {
        const response = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m`
        );
        const data = await response.json();
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(data, null, 2),
            },
          ],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Weather API error: ${error}`
        );
      }
    }

    case 'get_location_weather': {
      const args = GetLocationWeatherArgsSchema.parse(request.params.arguments);
      const { state } = args;
      
      // Coordenadas de ejemplo para algunos estados (podrías expandir esto)
      const stateCoordinates: Record<string, { lat: number; lon: number }> = {
        'california': { lat: 36.7783, lon: -119.4179 },
        'texas': { lat: 31.9686, lon: -99.9018 },
        'florida': { lat: 27.6648, lon: -81.5158 },
        'new york': { lat: 42.1657, lon: -74.9481 },
        'illinois': { lat: 40.3363, lon: -89.0022 },
      };
      
      const coords = stateCoordinates[state.toLowerCase()];
      if (!coords) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `State "${state}" not found. Available states: ${Object.keys(stateCoordinates).join(', ')}`
        );
      }
      
      try {
        const response = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current_weather=true&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m`
        );
        const data = await response.json();
        
        return {
          content: [
            {
              type: 'text',  
              text: `Weather for ${state}:\n${JSON.stringify(data, null, 2)}`,
            },
          ],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Weather API error: ${error}`
        );
      }
    }

    default:
      throw new McpError(
        ErrorCode.MethodNotFound,
        `Unknown tool: ${request.params.name}`
      );
  }
});

// Servidor HTTP para Render
const app = express();
const port = parseInt(process.env.PORT || '3000', 10);

app.get('/', (req: Request, res: Response) => {
  res.json({ 
    message: 'Weather MCP Server is running',
    status: 'healthy',
    tools: ['get_weather', 'get_location_weather']
  });
});

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Iniciar servidor HTTP
const httpServer = app.listen(port, '0.0.0.0', () => {
  console.log(`HTTP server running on port ${port}`);
});

// Iniciar servidor MCP solo en desarrollo local
if (process.env.NODE_ENV !== 'production') {
  const transport = new StdioServerTransport();
  mcpServer.connect(transport);
  console.log('MCP stdio server started for local development');
}

// Manejo de cierre limpio
process.on('SIGINT', () => {
  console.log('Shutting down servers...');
  httpServer.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
