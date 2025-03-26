## 环境要求

- Python 3.6 或更高版本
- pip 包管理器

## 部署步骤

1. 确保 Python 已正确安装，可以通过以下命令检查：

```bash
python3 --version
```

2. 安装所需的 Python 包：

```bash
pip install -r src/stamps/python/requirements.txt
```

3. 确保 Python 脚本具有执行权限：

```bash
chmod +x src/stamps/python/stamp_generator.py
```

## 故障排除

如果遇到字体相关问题，请确保：

1. 上传的自定义字体位于 `uploads/fonts` 目录中
2. 字体文件扩展名为 `.ttf` 或 `.otf`
3. 系统安装了基本字体（如 Arial）作为后备选项

如果遇到 Python 执行问题，请检查：

1. 确保 Python 3 已安装并且可以通过 `python3` 命令访问
2. 确保图章生成脚本具有执行权限
3. 检查日志输出是否有 Python 错误信息 