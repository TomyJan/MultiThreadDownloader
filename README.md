# 基础用法（默认4线程，落盘到 downloads）
node downloader.js --url https://example.com/file.zip

# 指定线程数与目录
node downloader.js --url https://example.com/file.zip --threads 8 --out D:\temp\dl

# 只统计不落盘（避免占用磁盘）
node downloader.js --url https://example.com/file.zip --save=false

# 自定义请求头（分号分隔）
node downloader.js --url https://example.com/file.zip --headers "User-Agent=MyUA;Authorization=Bearer token"

# 静默进度（仅关键完成/错误日志）
node downloader.js --url https://example.com/file.zip --quiet=true

# 16线程为傻逼刷流量
node downloader.js --url https://r2.072103.xyz/lp223.zpaq --save=false --threads 16
# 只刷连接数模式
node downloader.js --url https://r2.072103.xyz/lp223.zpaq --save=false --connect-only=true --threads 16
# 或者
node downloader.js --url https://r2.072103.xyz/2xnzlskypro223.zpaq --save=false --threads 16
