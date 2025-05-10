import NodeMediaServer from 'node-media-server';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import path from 'path';
import { Context, Logger} from 'ejun';
import fs from 'fs-extra';
import os from 'os';
const logger = new Logger('streamer');

const mediaRoot = path.resolve(os.homedir(), '.ejunz', 'media', 'live');
fs.ensureDirSync(mediaRoot);

export function startLiveServer() {
  const config = {
    logType: 2,
    rtmp: {
      port: 1935,
      chunk_size: 60000,
      gop_cache: true,
      ping: 30,
      ping_timeout: 60,
      ip: '0.0.0.0',
    },
    http: {
      port: 8001,
      allow_origin: '*',
      hostname: '0.0.0.0',
    },
    trans: {
      ffmpeg: ffmpegInstaller.path,
      tasks: [
        {
          app: 'live',
          hls: true,
          hlsFlags: '[hls_time=2:hls_list_size=3:hls_flags=delete_segments]',
          hlsKeep: true,
          hlsPath: mediaRoot,
          mediaRoot: mediaRoot,
          dash: false,
        },
      ],
    },
  };

  const nms = new NodeMediaServer(config);
  nms.run();

  nms.on('postPublish', (id, streamPath, args) => {
    logger.info(`postPublish: ${streamPath}`);
  });
  
  
  nms.on('prePublish', (id, streamPath, args) => {
    logger.info(`prePublish: ${streamPath}`);
  });
  
  nms.on('donePublish', (id, streamPath, args) => {
    logger.info(`donePublish: ${streamPath}`);
  });
  

  logger.info(`[DEBUG] startLiveServer loaded, mediaRoot = ${mediaRoot}`);

  logger.info('[RTMP Server] Live server started on rtmp://localhost:1935/live');
  logger.info('[RTMP Server] HLS playback on http://localhost:8001/live/<streamKey>/index.m3u8');
}
