import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { configureMonacoYaml } from 'monaco-yaml';
import problemConfigSchema from '../schema/problemconfig';

configureMonacoYaml(monaco, {
  validate: true,
  enableSchemaRequest: true,
  hover: true,
  completion: true,
  format: false,
  schemas: [
    {
      uri: 'https://.js.org/schema/problemConfig.json',
      fileMatch: ['://problem/file/config.yaml'],
      schema: problemConfigSchema as any,
    },
    {
      uri: new URL('/manage/config/schema.json', window.location.href).toString(),
      fileMatch: ['://system/setting.yaml'],
    },
  ],
});
