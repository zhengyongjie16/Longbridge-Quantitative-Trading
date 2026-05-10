# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目简介

基于 Longbridge OpenAPI SDK for Node.js / bun / TypeScript 的港股自动化量化交易系统。

## 项目结构示例

```
src/
├── index.ts      # 主入口
├── app/          # 应用组装层
├── config/       # 配置模块
├── constants/    # 全局常量定义
├── types/        # 全局公共类型定义
├── main/         # 主程序架构模块
├── core/         # 核心业务逻辑
├── services/     # 外部服务
└── utils/        # 工具模块
```

## 第一性原理

请使用第一性原理思考。你不能总是假设我非常清楚自己想要什么和该怎么得到。请保持审慎，从原始需求和问题出发，如果动机和目标不清晰，停下来和我讨论。

## 代码基础规范

当你需要编写任何TypeScript代码时，强制使用typescript-project-specifications skill

## 方案和代码逻辑规范

当需要你给出修改或重构方案时必须符合以下规范:

- 优先考虑事件驱动设计
- 优先以fail-fast原则为主，特定的外部api请求允许进入重试（应与我确认）
- 不允许给出兼容性或补丁性的方案
- 不允许过度设计，保持最短路径实现且不能违反第一条要求
- 不允许自行给出我提供的需求以外的方案，例如一些兜底、降级和重试方案，这可能导致业务逻辑偏移问题
- 必须确保方案的逻辑正确，必须经过全链路的逻辑验证
