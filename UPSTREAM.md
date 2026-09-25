# 依赖来源

本项目保留 `@earendil-works/pi-ai` 和 `@earendil-works/pi-telemetry` 作为 AI 对话的
底层库。它们提供模型协议、流式事件和遥测类型；项目没有 Pi Agent、终端 UI、远程
会话或 Agent 工具运行时。

题目格式和界面行为参考 [Hydro](https://github.com/hydro-dev/Hydro)，生成与校验使用
[Testlib](https://github.com/MikeMirzayanov/testlib)。AI 底层库的上游来源是
[pi](https://github.com/earendil-works/pi)；同步上游代码时只保留本项目实际需要的
AI 与遥测依赖，并运行 Hydro 的检查和测试。
