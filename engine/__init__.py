# -*- coding: utf-8 -*-
"""《工业革命·兰开夏》本地对局引擎（服务端权威）。

模块划分：
  data       静态数据加载与索引（data/*.json）
  state      状态结构与运输网派生
  mechanics  面板/翻面/收入轨/煤铁取用/资源市场
  setup      开局初始化（牌库、发牌、顺位）
  flow       回合·轮次·时代流转、收入结算、计分、按钮重算
  actions    六行动 + 双牌建造 + 撤回（统一入口 apply_action）
  build      旧版煤厂建造实现（保留兼容，新代码请用 actions）
"""
from . import data, state, mechanics, setup, flow, actions, build
from .setup import create_game
from .actions import apply_action

__all__ = ['data', 'state', 'mechanics', 'setup', 'flow', 'actions', 'build',
           'create_game', 'apply_action']
