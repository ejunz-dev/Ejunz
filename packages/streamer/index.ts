import { Context, Handler } from 'ejun';
import fs from 'fs';
import path from 'path';
import { startLiveServer, mediaRoot } from './server';

export class LiveServerHandler extends Handler {
  async get() {
    const streamKey = this.params.streamKey || 'test';
    const hlsPath = path.join(mediaRoot, streamKey, 'index.m3u8');

    if (fs.existsSync(hlsPath)) {
      this.response.body = {
        playing: true,
        streamKey,
        url: `http://localhost:8001/live/${streamKey}/index.m3u8`,
      };
    } else {
      this.response.body = {
        playing: false,
        streamKey,
        message: 'no live stream',
      };
    }
  }
}

export async function apply(ctx: Context) {
  startLiveServer();
  ctx.Route('live', '/live/:streamKey', LiveServerHandler);
}
