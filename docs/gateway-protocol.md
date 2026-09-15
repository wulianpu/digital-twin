# 平台数据网关协议（Gateway Protocol）

> 版本：草案 v1（随 I3 迭代演进；实现参考 `@twin/world-client` 的 `createWebSocketSource`）
> 边界：浏览器**只**通过本协议访问世界数据，永不直连 OT/PLC（冻结文档 §34、§81）。

## 1. 传输

- WebSocket（生产必须 `wss://`），文本帧，UTF-8 JSON。
- 一条连接承载该会话的全部订阅；帧交错无顺序保证，**同一 key 的信封以 revision 定序**。

## 2. 数据信封（DataEnvelope）

服务端下发的业务数据帧一律为 DataEnvelope（单个对象或数组）：

```json
{
  "contract": "twin.vessel.state@1",
  "key": "ais/412345001",
  "sourceTime": 1789000000000,
  "ingestTime": 1789000000123,
  "revision": 48111,
  "quality": "good",
  "payload": { }
}
```

| 字段 | 约束 |
|---|---|
| `contract` | Domain 契约 ID（`<域>.<实体>.state@<版本>`），Foundation 不理解其语义 |
| `key` | 会话内稳定，格式 `namespace/id`（如 `ais/MMSI`、`production/CRANE-003`） |
| `sourceTime` | 服务器 epoch 毫秒；质量判定与历史对齐的基准 |
| `revision` | **同一 key、同一 LIVE transport 内单调递增**；客户端丢弃 `revision <= 缓存值` 的信封。排序域仅限当前连接/时间线（见 §5.1） |
| `quality` | `good` / `stale` / `bad` / `unknown`；客户端亦会按本地陈旧窗口降级为 `stale` |

`payload` 语义由 Domain 契约定义（如 `twin.vessel.state@1`），平台透传。

## 3. 客户端 → 服务端帧

```json
{ "type": "subscribe",   "query": { "contract": "…", "keys": ["…"], "scope": { "kind": "site", "siteId": "…" } } }
{ "type": "unsubscribe", "query": { "contract": "…" } }
{ "type": "ping", "ts": 1789000000000 }
```

- `query.keys` / `query.scope` 可省略（省略 = 该 contract 全量）。
- 可选鉴权：连接建立后、任何 `subscribe` 前发送首帧
  `{ "type": "auth", "token": "…" }`；未通过前服务端只允许回应 `error`。

## 4. 服务端 → 客户端帧

| 帧 | 说明 |
|---|---|
| `DataEnvelope` / `DataEnvelope[]` | 数据（增量或快照） |
| `{ "type": "pong", "ts": … }` | 心跳应答 |
| `{ "type": "error", "code": "…", "message": "…", "query": … }` | 错误帧；连接保持，客户端经 `onError` 上报 |

错误码建议：`unknown-contract` / `unauthorized` / `bad-query` / `rate-limited`。

## 5. 订阅与快照语义

1. `subscribe` 后服务端**先推送该查询的当前快照，再推送增量**。
2. 客户端重连后会**重发全部活跃订阅**；服务端必须重放快照。
3. 客户端按 `revision` 去重：快照重放中较旧的信封不会覆盖新状态。
4. 同一 query 的重复 `subscribe` 幂等；最后一个消费方 `unsubscribe` 后服务端停止推送。

## 6. 心跳与重连

- 客户端每 `heartbeatMs`（默认 30s）发送 `ping`；
  **超过 2 个周期未收到 `pong`** 即判定假死，主动断开并重连。
- 重连退避：`backoffMs`（默认 500ms）×2 递增，封顶 `maxBackoffMs`（默认 15s）。
- 重连成功（`onopen`）：清零退避、重发订阅。以上参数均可经
  `createWebSocketSource({ url, heartbeatMs, backoffMs, maxBackoffMs })` 配置。

## 7. 历史回放（History）

两种等价形态，部署任选其一：

- **WS 查询**：`{ "type": "history-query", "query": { "contract": "…" }, "from": ts, "to": ts, "stepMs": 1000 }`，
  服务端按时间片回放帧序列。
- **REST 快照**：`GET /history?contract=…&from=…&to=…&stepMs=…` 返回
  `[{ "timeMs": …, "envelopes": [DataEnvelope…] }]` 帧数组。

客户端统一经 `createReplaySource({ frames })` 包装为 history 源；
`seek(timeMs)` 定位到「≤ t 的最近一帧」。

### 7.1 revision 排序域与 timeline rewind（Issue #11）

`revision` 的单调性只在**同一 LIVE transport 连接内**作为乱序/重放去重的排序域：

- **LIVE**：revision 是 transport ordering authority。重连后旧快照（较低 revision）不得覆盖更新数据；mode 往返（LIVE→HISTORY→LIVE）后 LIVE 游标保留。
- **HISTORY / SIMULATION**：world timeline（`seek(timeMs)` / scrubber）是排序权威。主动 rewind 后**较低的 revision 恰恰是用户选择的更早正确世界状态**，不得被当作 stale packet 丢弃。

因此客户端（WorldClient）在每次 HISTORY `seek` 时开启新的 timeline epoch
（`DataApi.beginTimelineEpoch('history')`），重置该模式的 revision 游标；
mode 切换本身也产生新的 mode generation，旧模式的异步 snapshot 整批丢弃。
服务端如未来提供真实历史 API，只需保持"seek 后按时间线正确重放"语义，
无需为 rewind 修改 revision 规则。
 Portal 在世界模式切换到 HISTORY 时以 world clock 驱动 `seek`。

## 8. 仿真（Simulation）

与 live 同构的第三个源（`kind: 'simulation'`）。要求生成过程**确定性**：
给定虚拟时间戳可重放一致状态，world clock 的 `speed`/`seek` 不产生协议层差异
（时间戳由客户端在数据外提供，服务端无需感知倍速）。

## 9. 客户端接线（Portal）

- 构建期 `VITE_GATEWAY_WS_URL` 指向网关 → live 源替换为 WS 传输（演示网关退役）。
- 顶栏连接指示展示 `connecting / open / closed` 与本地陈旧项数量
  （`WorldClient.countStale()`），即「质量降级可见」（I3-3）。
- 历史/仿真源的生产替换点是 `apps/portal/src/foundation.ts` 中唯一的
  `createHistorySimulationSources()`（I3-4）：接服务端后删除演示实现即可，Scene 零修改。
