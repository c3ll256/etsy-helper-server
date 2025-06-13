import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class RemoteAreaService {
  private readonly logger = new Logger(RemoteAreaService.name);
  private remoteAreas: string[] = [];

  constructor() {
    this.loadRemoteAreas();
  }

  private loadRemoteAreas() {
    try {
      const filePath = path.join(process.cwd(), 'src', 'config', 'remote-areas.json');
      if (fs.existsSync(filePath)) {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        const config = JSON.parse(fileContent);
        this.remoteAreas = config.remoteAreas.map(area => area.toUpperCase());
        this.logger.log(`Loaded ${this.remoteAreas.length} remote areas.`);
      } else {
        this.logger.warn('Remote areas config file not found at src/config/remote-areas.json');
      }
    } catch (error) {
      this.logger.error('Failed to load or parse remote areas config file.', error.stack);
    }
  }

  isRemoteArea(state: string): boolean {
    if (!state) {
      return false;
    }
    return this.remoteAreas.includes(state.trim().toUpperCase());
  }
} 