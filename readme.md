# 光梦验证机器人

## 配置

1. 安装 NapCat https://napneko.github.io/

2. 访问 linux 一键安装 

3. 输入 shell 脚本

```shell
curl -o \
napcat.sh \
https://nclatest.znin.net/NapNeko/NapCat-Installer/main/script/install.sh \
&& sudo bash napcat.sh
```

4. 使用 docker 方式安装 napcat ，并输入QQ号，以及 `ws` 用作启动模式

5. 安装后打开 docker 容器日志，查找 `WebUi` 的 `url` ，并登录 Napcat 后台

6. 初始化密码后，创建 WS 服务器

7. 根据创建服务器填写的TOKEN，编辑项目文件 `.env` 里的 TOKEN

8. 运行 `npm run start` 命令启动验证服务