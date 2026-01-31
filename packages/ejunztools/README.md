# @ejunz/ejunztools

Market 中的 **system 工具**独立包，供 ejun 的 tool market 与 agent 调用。

## 内容

- **SYSTEM_TOOLS_CATALOG**：系统工具目录（如 `get_current_time`），用于市场展示与 agent 工具列表。
- **executeSystemTool(name, args)**：按名称执行系统工具。

## 使用

```ts
import { SYSTEM_TOOLS_CATALOG, executeSystemTool } from '@ejunz/ejunztools';

// 列举系统工具
SYSTEM_TOOLS_CATALOG.forEach(t => console.log(t.name));

// 执行
const result = executeSystemTool('get_current_time', { timezone: 'Asia/Shanghai' });
```

## 扩展

在 `src/catalog.ts` 中增加 `SYSTEM_TOOLS_CATALOG` 条目，在 `src/execute.ts` 中增加对应分支即可扩展新系统工具。
