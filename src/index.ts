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
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { WebSocketTransport } from '@modelcontextprotocol/sdk/server/websocket.js';
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

// Crear servidor HTTP
const httpServer = createServer(app);

// Servidor WebSocket para MCP
const wss = new WebSocketServer({ server: httpServer });

// Manejar conexiones WebSocket MCP
wss.on('connection', (ws) => {
  console.log('Nueva conexión WebSocket MCP');
  
  // Crear un "transport" manual para WebSocket
  const sendResponse = (response: any) => {
    ws.send(JSON.stringify(response));
  };
  
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('Mensaje recibido:', message);
      
      // Manejar diferentes tipos de mensajes MCP
      switch (message.method) {
        case 'initialize':
          sendResponse({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: {}
              },
              serverInfo: {
                name: 'weather',
                version: '1.0.0'
              }
            }
          });
          break;
          
        case 'notifications/initialized':
          // No necesita respuesta
          break;
          
        case 'tools/list':
          sendResponse({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: [
                {
                  name: 'get_weather',
                  description: 'Get current weather for a location by coordinates',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      latitude: { type: 'number', description: 'Latitude coordinate' },
                      longitude: { type: 'number', description: 'Longitude coordinate' }
                    },
                    required: ['latitude', 'longitude']
                  }
                },
                {
                  name: 'get_location_weather',
                  description: 'Get current weather for a US state',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      state: { type: 'string', description: 'US state name' }
                    },
                    required: ['state']
                  }
                }
              ]
            }
          });
          break;
          
        case 'tools/call':
          await handleToolCall(message, sendResponse);
          break;
          
        default:
          sendResponse({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32601,
              message: `Method not found: ${message.method}`
            }
          });
      }
    } catch (error) {
      console.error('Error procesando mensaje:', error);
      sendResponse({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error'
        }
      });
    }
  });
  
  ws.on('close', () => {
    console.log('Conexión WebSocket cerrada');
  });
});

// Función para manejar llamadas a herramientas
async function handleToolCall(message: any, sendResponse: (response: any) => void) {
  const { name, arguments: args } = message.params;
  
  try {
    let result;
    
    switch (name) {
      case 'get_weather':
        const { latitude, longitude } = args;
        const weatherResponse = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m`
        );
        const weatherData = await weatherResponse.json();
        
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify(weatherData, null, 2)
            }
          ]
        };
        break;
        
      case 'get_location_weather':
        const { state } = args;
        const stateCoordinates: Record<string, { lat: number; lon: number }> = {
          'california': { lat: 36.7783, lon: -119.4179 },
          'texas': { lat: 31.9686, lon: -99.9018 },
          'florida': { lat: 27.6648, lon: -81.5158 },
          'new york': { lat: 42.1657, lon: -74.9481 },
          'illinois': { lat: 40.3363, lon: -89.0022 }
        };
        
        const coords = stateCoordinates[state.toLowerCase()];
        if (!coords) {
          throw new Error(`State "${state}" not found`);
        }
        
        const stateWeatherResponse = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current_weather=true&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m`
        );
        const stateWeatherData = await stateWeatherResponse.json();
        
        result = {
          content: [
            {
              type: 'text',
              text: `Weather for ${state}:\n${JSON.stringify(stateWeatherData, null, 2)}`
            }
          ]
        };
        break;
        
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    
    sendResponse({
      jsonrpc: '2.0',
      id: message.id,
      result
    });
    
  } catch (error) {
    sendResponse({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32000,
        message: `Tool execution failed: ${error}`
      }
    });
  }
}

app.get('/', (req: Request, res: Response) => {
  res.json({ 
    message: 'Weather MCP Server with WebSocket support',
    status: 'healthy',
    websocket_url: `ws://${req.get('host')}/`,
    info: 'Connect via WebSocket for MCP protocol'
  });
});

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Iniciar servidor HTTP con WebSocket
httpServer.listen(port, '0.0.0.0', () => {
  console.log(`HTTP server running on port ${port}`);
  console.log(`WebSocket server ready for MCP connections`);
});

// Servidor WebSocket para MCP
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  console.log('New MCP WebSocket connection');
  const transport = new WebSocketTransport(ws);
  mcpServer.connect(transport);
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
  wss.close(() => {
    httpServer.close(() => {
      console.log('Servers closed');
      process.exit(0);
    });
  });
});
