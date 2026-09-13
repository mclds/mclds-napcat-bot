import { NCWebsocket, Structs } from 'node-napcat-ts'
import dotenv from 'dotenv';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';

dotenv.config();

const config = {
    host: process.env.HOST,
    port: process.env.PORT,
    token: process.env.TOKEN,
    group_id: process.env.GROUP_ID,
    notify_email: process.env.NOTIFY_EMAIL,
    notify_api: process.env.NOTIFY_API,
    chat_history_save_path: process.env.CHAT_HISTORY_SAVE_PATH,
    max_chat_history: parseInt(process.env.MAX_CHAT_HISTORY ?? '100'),
    verify_records_file: process.env.VERIFY_RECORDS_FILE,
    verify_whitelist_file: process.env.VERIFY_WHITELIST_FILE,
    verify_success_file: process.env.VERIFY_SUCCESS_FILE,
    /** 非正版审核：单向通知 HTTP 接口（Web 服务在玩家提交问卷后调用 → 发群通知管理员） */
    notify_http_port: parseInt(process.env.NOTIFY_HTTP_PORT || '3002'),
    notify_secret: process.env.NOTIFY_SECRET || '',
    notify_admin_qq: process.env.NOTIFY_ADMIN_QQ || '',
    /** 管理员 QQ 列表（逗号分隔），用于「卡片查询」指令鉴权，缺省回退到 notify_admin_qq */
    admin_qqs: (process.env.ADMIN_QQS || process.env.NOTIFY_ADMIN_QQ || '').split(',').map(s => s.trim()).filter(Boolean),
    /** 玩家信息卡片渲染 API（mclds-admin 内网接口） */
    player_card_api: process.env.PLAYER_CARD_API || 'http://127.0.0.1:3067',
    /** 查询限制 */
    query_limit_seconds: 3,
    code_length: 4,
}


const limits = new Map()

/**
 * @type {Command[]}
 */
const registered_commands = []

console.log(config);
console.log('启动中...');

(async () => {

    if (!config.host || !config.port || !config.token) {
        throw new Error('process.env.HOST is required')
    }

    const napcat = new NCWebsocket({
        // https 的话使用 'wss'
        protocol: 'ws',
        host: config.host,
        port: parseInt(config.port),
        accessToken: config.token,
        throwPromise: true,
        // ↓ 自动重连(可选)
        reconnection: {
            enable: true,
            attempts: 10,
            delay: 5000
        }
        // ↓ 是否开启 DEBUG 模式
    }, false)

    console.log('连接中...');
    try {
        await napcat.connect()
    } catch (e) {
        console.error('连接失败：', e);
        return
    }
    console.log('连接成功！');

    // 单向通知 HTTP 接口（Web 审核服务在玩家提交问卷后调用 → 发群通知管理员审核）
    const notifyServer = http.createServer(async (req, res) => {
        const path = (req.url || '').split('?')[0];
        if (req.method !== 'POST' || path !== '/api/notify') {
            res.writeHead(404, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'not found' }));
        }
        try {
            const data = JSON.parse((await readBody(req)) || '{}');
            if (data.secret !== config.notify_secret) {
                res.writeHead(401, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ error: 'unauthorized' }));
            }
            const player = data.player || {};
            const reviewUrl = data.review_url || '';
            const message = [
                ...(config.notify_admin_qq ? [Structs.at(parseInt(config.notify_admin_qq))] : []),
                Structs.text(`🛡 新玩家身份审核\n玩家：${player.name || '未知'}\n认证类型：${authLabel(player.authService)}\n点击审核：${reviewUrl}`),
            ];
            await napcat.send_group_msg({ group_id: parseInt(config.group_id), message });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        } catch (e) {
            console.error('[notify] 处理失败：', e);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: String(e?.message || e) }));
        }
    });
    notifyServer.listen(config.notify_http_port, '127.0.0.1', () => {
        console.log(`[notify] 通知服务监听 http://127.0.0.1:${config.notify_http_port}/api/notify`);
    });


    napcat.once('socket.close', () => {

        if (!config.notify_email || !config.notify_api) {
            console.warn('连接已关闭，notify_email或notify_api未配置，无法发送通知邮件，请检查服务器状态！')
            return
        }

        console.log(new Date().toLocaleString(), '连接已关闭，即将发送邮件通知管理员检查服务器状态：=> ', config.notify_email);
        // 连接问题，发送邮件
        fetch(config.notify_api, {
            method: 'POST',
            body: JSON.stringify({
                to: config.notify_email,
                subject: '光梦机器人Napcat连接已关闭',
                html: `光梦机器人Napcat连接已关闭，请检查服务器状态！\n\n${new Date().toLocaleString()}`
            })
        })
    })

    napcat.on('message', async (ctx) => {

        /**
         * 快捷回复：私聊回复私信，群聊回复群消息（可 @ 发送者）
         * @param {(string | import('node-napcat-ts').SendMessageSegment)[]} msgs 字符串或消息段（如 Structs.image）
         * @param {boolean} [at_sender] 群聊时是否 @ 发送者
         */
        const quick_action = async (msgs = [], at_sender = false) => {
            const message = msgs.map(s => typeof s === 'string' ? Structs.text(s) : s)
            if (ctx.message_type === 'group') {
                await napcat.send_group_msg({
                    group_id: ctx.group_id,
                    message: [...(at_sender ? [Structs.at(ctx.user_id), Structs.text(' ')] : []), ...message]
                })
            } else {
                await napcat.send_private_msg({
                    user_id: ctx.user_id,
                    message
                })
            }
        }

        // 群聊天记录保存
        if (ctx.message_type === 'group' && ctx.group_id === parseInt(config.group_id?.toString() || '0')) {
            try {
                if (config.chat_history_save_path && existsSync(config.chat_history_save_path)) {
                    const data = JSON.parse(readFileSync(config.chat_history_save_path, { encoding: 'utf-8' }))
                    const records = data['records']
                    if (records.length > config.max_chat_history) {
                        records.shift()
                    }
                    records.push(ctx)
                    writeFileSync(config.chat_history_save_path, JSON.stringify(data))
                }
            } catch (e) {
                console.error('error message ctx => ', ctx.message.map(m => m.type === 'text' ? m.data.text.trim() : '').filter(Boolean).join(' | '));
                console.error('保存聊天记录出现错误：', e)
            }
        }

        // 群聊命令（仅公开命令可用，其余命令提示私聊使用）
        if (ctx.message_type === 'group' && ctx.group_id === parseInt(config.group_id?.toString() || '0') && registered_commands.length > 0) {
            const messages = ctx.message.map(m => m.type === 'text' ? m.data.text.trim() : '').filter(Boolean)
            const first_word = (messages[0] || '').split(' ')[0]
            const match_command = registered_commands.find(c => first_word === c.name || first_word === '/' + c.name)
            if (match_command) {
                try {
                    if (!match_command.public) {
                        return await quick_action(['⚠️请私聊我使用该功能'])
                    }
                    const msgs = ctx.message.map(m => String(Reflect.get(m.data, 'text')) || '')
                    const [cmd, ...args] = msgs[0].split(' ').filter(s => s.trim())
                    await match_command.handler(args, quick_action, ctx)
                } catch (e) {
                    console.error(e)
                    await quick_action(['⚠️命令执行中出现错误，请稍后重试！'])
                }
                return
            }
        }


        // 进服验证
        if (ctx.message_type === 'private') {
            const messages = ctx.message.map(m => m.type === 'text' ? m.data.text.trim() : '').filter(Boolean)
            console.log('[私信]', ctx.sender.nickname, ctx.sender.user_id.toString(), '=>', messages)

            try {


                // 命令处理（公开命令所有人可用，其余命令需群管理权限）
                if (registered_commands.length > 0) {
                    const first_word = (messages[0] || '').split(' ')[0]
                    const match_command = registered_commands.find(c => first_word === c.name || first_word === '/' + c.name)
                    const [send_command] = (messages[0] || '').match(/\/([a-zA-Z\u4e00-\u9fa5_-])/) || []
                    if (send_command || match_command) {
                        // 非公开命令：检查管理员权限
                        if (!match_command?.public) {
                            const info = await napcat.get_group_member_info({
                                group_id: parseInt(config.group_id || ''),
                                user_id: ctx.user_id
                            })
                            if (info.role === 'member') {
                                return await quick_action(['⚠️你无权使用命令'])
                            }
                        }


                        try {
                            if (match_command) {
                                const msgs = ctx.message.map(m => String(Reflect.get(m.data, 'text')) || '')
                                const [cmd, ...args] = msgs[0].split(' ').filter(s => s.trim())
                                await match_command.handler(args, quick_action, ctx)
                            } else {
                                await quick_action([
                                    '当前可用命令如下：\n',
                                    ...(registered_commands.map(c => `————————————\n▶️/${c.name} ${c.args}\n📄${c.desc}\n`))
                                ])
                            }
                            return
                        } catch (e) {
                            console.error(e)
                            return await quick_action([
                                '命令执行中出现错误：\n',
                                // @ts-ignore
                                String(e?.message || e)
                            ])
                        }
                    }

                }

                if (config.verify_records_file && existsSync(config.verify_records_file)) {
                    const data = JSON.parse(readFileSync(config.verify_records_file, { encoding: 'utf-8' }))

                    /** @type {VerifyRecordData[]} */
                    const json = data['records']

                    const messages = ctx.message.map(m => m.type === 'text' ? m.data.text.trim() : '').filter(Boolean)

                    for (const msg of messages) {
                        const code = (msg.match(/(\d+)/) || [])?.[1]?.trim() || ''

                        if (code?.length !== config.code_length) {
                            continue
                        }
                        if (!config.group_id) {
                            await quick_action(['⚠️群数据错误！请联系管理员'])
                            return
                        }

                        // QQ
                        const qq = String(ctx.user_id)


                        if (limits.get(qq)) {
                            const time = limits.get(qq)
                            if (Date.now() - time < config.query_limit_seconds * 1000) {
                                await quick_action(['⚠️查询太频繁了，请稍后再试！'])
                                return
                            }
                        }

                        limits.set(qq, Date.now())


                        const record_index = json.findIndex(j => j.code === code)
                        if (record_index === -1) {
                            await quick_action(['⚠️未查询到验证数据！请检查验证码是否正确，或者是否过期，或者联系管理员处理。'])
                            return
                        }

                        //  查找用户是否加群 
                        const members = await napcat.get_group_member_list({ group_id: parseInt(config.group_id), no_cache: true })
                        const member_infos = members.map(m => ({ qq: String(m.user_id), card: m.card }))

                        if (member_infos.find(i => String(i.qq) === qq) === undefined) {
                            await quick_action(['⚠️检测到您尚未加群！' + config.group_id])
                            return
                        }
                        console.log((qq));

                        const uuid = json[record_index].uuid
                        const name = json[record_index].name // splice 前先取出名字（splice 后该下标已移位）
                        if (!config.verify_success_file) {
                            await quick_action(['⚠️数据保存路径不存在！请联系服务器管理员'])
                            return
                        }

                        mkdirSync(basename(config.verify_success_file), { recursive: true })
                        if (existsSync(config.verify_success_file) === false) {
                            writeFileSync(config.verify_success_file, JSON.stringify({ records: [] }))
                        }

                        const verify_data = JSON.parse(readFileSync(config.verify_success_file, { encoding: 'utf-8' }))
                        /** @type {VerifySuccessData[]} */
                        const verify_json = verify_data['records']
                        const verified = verify_json.find(j => String(j.qq) === qq)
                        if (verified) {
                            await quick_action([`⚠️当前QQ号已经存在绑定！请联系管理员处理`])
                            return
                        }

                        // 验证成功
                        await quick_action([`🎉验证成功！欢迎加入光梦服务器，重新进服即可。`, `进服前请阅读群公告，以及光梦百科：mclds.com`])
                        json.splice(record_index, 1)
                        writeFileSync(config.verify_records_file, JSON.stringify(data))


                        verify_json.push({
                            qq: qq,
                            uuid: uuid,
                            time: new Date().toLocaleString('zh-cn'),
                            names: [name] // 写入时带上名字（lobby 已改为纯 reader，不再回写补名）
                        })
                        writeFileSync(config.verify_success_file, JSON.stringify(verify_data))
                        return
                    }

                    await quick_action(['⚠️机器人只支持服务器进服验证消息，格式为4-6位数字，其他问题请联系群腐竹哦~'])
                }
            } catch (error) {
                console.error(error)
                await quick_action(['❌️未知错误：' + error])
            }
        }
    })



    registerCommand('QQ查信息', '<QQ号码>', '输入QQ查询玩家信息', async (args, quick_action) => {
        if (!config.verify_success_file) {
            return await quick_action(['⚠️数据保存路径不存在！请联系服务器管理员'])
        }
        const verify_data = JSON.parse(readFileSync(config.verify_success_file, { encoding: 'utf-8' }))
        /** @type {VerifySuccessData[]} */
        const verify_json = verify_data['records']

        const qq = args[0]

        const info = verify_json.find(d => d.qq === qq)
        if (!info) {
            return await quick_action(['⚠️未查询到信息！'])
        }
        return await quick_action([`QQ：${qq}
曾用名：${info.names.join(',')}
加入时间：${info.time}
UUID：${info.uuid}`])

    })


    registerCommand('游戏名查信息', '<玩家游戏ID例如ennncy>', '输入玩家ID名查询QQ', async (args, quick_action) => {
        if (!config.verify_success_file) {
            await quick_action(['⚠️数据保存路径不存在！请联系服务器管理员'])
            return
        }

        const verify_data = JSON.parse(readFileSync(config.verify_success_file, { encoding: 'utf-8' }))
        /** @type {VerifySuccessData[]} */
        const verify_json = verify_data['records']


        const id = args[0]

        const info = verify_json.find(d => d.names.some(n => n === id))
        if (!info) {
            return await quick_action(['⚠️未查询到信息！'])
        }
        return await quick_action([`QQ：${info.qq}
曾用名：${info.names.join(',')}
加入时间：${info.time}
UUID：${info.uuid}`])


    })


    registerCommand('游戏名搜索信息', '<玩家游戏名（可输入部分字符进行模糊搜索）>', '输入玩家游戏名搜索玩家信息', async (args, quick_action) => {
        if (!config.verify_success_file) {
            await quick_action(['⚠️数据保存路径不存在！请联系服务器管理员'])
            return
        }

        const verify_data = JSON.parse(readFileSync(config.verify_success_file, { encoding: 'utf-8' }))
        /** @type {VerifySuccessData[]} */
        const verify_json = verify_data['records']


        const id = args[0]
        if (id.length < 3) {
            return await quick_action(['⚠️至少提供3个字符'])
        }

        const infos = verify_json.filter(d => d.names.some(n => n.includes(id)))
        if (infos.length <= 0) {
            return await quick_action(['⚠️未搜索到信息！'])
        }

        return await quick_action(infos.map(i => `——————————\nQQ：${i.qq}\n曾用名：${i.names.join(',')}\n`))
    })

    registerCommand('添加白名单', '<玩家游戏名ID> <理由>', '将无法验证的玩家加入白名单', async (args, quick_action) => {
        if (!config.verify_whitelist_file || !config.verify_records_file) {
            return await quick_action(['⚠️数据保存路径不存在！请联系服务器管理员'])

        }

        /** @type {VerifyWhiteListData[]} */
        const whitelist_json = JSON.parse(readFileSync(config.verify_whitelist_file, { encoding: 'utf-8' }))['whitelist']
        /** @type {VerifyRecordData[]} */
        const records_json = JSON.parse(readFileSync(config.verify_records_file, { encoding: 'utf-8' }))['records']


        const id = args[0] || ''
        const reason = args[1]

        if (!id) {
            return await quick_action(['⚠️请输入玩家ID'])
        }

        if (whitelist_json.find(w => w.names.some(n => n === id.trim()))) {
            return await quick_action(['⚠️该玩家已经在白名单中'])
        }

        if (!reason) {
            return await quick_action(['⚠️请输入理由'])
        }

        const record = records_json.find(r => r.name.trim() === id.trim())
        if (!record) {
            return await quick_action(['⚠️未找到进服申请数据，请联系该玩家重新申请，并在此期间完成白名单加入'])
        }

        whitelist_json.push({
            uuid: record.uuid,
            names: [record.name],
            reason
        })

        // 仅移除该玩家的待验证记录（原为 ===，会误删其他所有玩家的验证码）
        writeFileSync(config.verify_records_file, JSON.stringify({ records: records_json.filter(r => r.uuid !== record.uuid) }))
        writeFileSync(config.verify_whitelist_file, JSON.stringify({ whitelist: whitelist_json }))


        return await quick_action([`✅成功将玩家${id}加入白名单！理由：${reason}，请通知玩家重新进服验证！`])
    })



    registerCommand('查看白名单', '', '查看白名单', async (args, quick_action) => {
        if (!config.verify_whitelist_file) {
            return await quick_action(['⚠️数据保存路径不存在！请联系服务器管理员'])

        }

        /** @type {VerifyWhiteListData[]} */
        const whitelist_json = JSON.parse(readFileSync(config.verify_whitelist_file, { encoding: 'utf-8' }))['whitelist']

        if (whitelist_json.length <= 0) {
            return await quick_action(['⚠️白名单为空！'])
        }

        return await quick_action(whitelist_json.map(w => `——————————\n玩家ID：${w.names.join(',')}\nUUID：${w.uuid}\n理由：${w.reason}\n`))
    })


    registerCommand('我的信息', '', '查询自己的玩家信息卡片', async (args, quick_action, ctx) => {
        const qq = String(ctx.user_id)
        if (!checkQueryLimit(qq)) {
            return await quick_action(['⚠️查询太频繁了，请稍后再试！'])
        }
        await sendPlayerCard(qq, quick_action)
    }, true)


    registerCommand('卡片查询', '<QQ号码>', '（管理员）查询指定QQ的玩家信息卡片，仅私聊可用', async (args, quick_action, ctx) => {
        if (ctx.message_type === 'group') {
            return await quick_action(['⚠️请私聊我使用该功能'])
        }
        if (!config.admin_qqs.includes(String(ctx.user_id))) {
            return await quick_action(['⚠️该功能仅管理员可用'])
        }
        const qq = (args[0] || '').trim()
        if (!/^\d{5,11}$/.test(qq)) {
            return await quick_action(['⚠️QQ号格式不正确！'])
        }
        await sendPlayerCard(qq, quick_action)
    })


    // registerCommand('update-nickname', '更新群里玩家的游戏昵称', (ctx) => { 
    // })
})()





process.on('unhandledRejection', console.error)
process.on('uncaughtException', console.error)




/**
 * 读取 HTTP 请求体
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', c => { data += c; });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

/**
 * 认证类型中文标签
 * @param {string} s
 * @returns {string}
 */
function authLabel(s){ return {OFFICIAL:'正版(Mojang)',BLESSING_SKIN:'外置(BlessingSkin)',CUSTOM_YGGDRASIL:'外置(LittleSkin)',FLOODGATE:'Bedrock',OFFLINE:'离线(非正版)',UNKNOWN:'未知'}[s]||s||'' }

/**
 *
 * @param {string} name
 * @param {Command['handler']} handler
 * @param {boolean} [is_public] 是否公开命令（所有人可用，无需群管理权限）
 */
function registerCommand(name = '', args = '', desc = '', handler, is_public = false) {
    registered_commands.push({
        name,
        args,
        desc,
        handler,
        public: is_public
    })
}

/**
 * 查询限流
 * @param {string} qq
 * @returns {boolean} true 表示放行
 */
function checkQueryLimit(qq) {
    const time = limits.get(qq)
    if (time && Date.now() - time < config.query_limit_seconds * 1000) {
        return false
    }
    limits.set(qq, Date.now())
    return true
}

/**
 * 按 QQ 查询绑定记录并回复玩家信息卡片
 * @param {string} qq
 * @param {(msgs: (string | import('node-napcat-ts').SendMessageSegment)[], at_sender?: boolean) => Promise<void>} quick_action
 */
async function sendPlayerCard(qq, quick_action) {
    if (!config.verify_success_file) {
        return await quick_action(['⚠️数据保存路径不存在！请联系服务器管理员'])
    }
    const verify_data = JSON.parse(readFileSync(config.verify_success_file, { encoding: 'utf-8' }))
    /** @type {VerifySuccessData[]} */
    const verify_json = verify_data['records']
    const info = verify_json.find(d => String(d.qq) === String(qq))
    if (!info) {
        return await quick_action(['⚠️不存在玩家信息！'])
    }
    try {
        const resp = await fetch(`${config.player_card_api}/api/player?uuid=${encodeURIComponent(info.uuid)}&width=700`, {
            signal: AbortSignal.timeout(20000)
        })
        if (resp.status === 404) {
            return await quick_action(['⚠️玩家数据不存在！'])
        }
        if (!resp.ok) {
            console.error('[玩家卡片] 渲染接口异常状态：', resp.status)
            return await quick_action(['⚠️渲染失败，请稍后重试！'])
        }
        const buf = Buffer.from(await resp.arrayBuffer())
        return await quick_action([Structs.image(buf)], true)
    } catch (e) {
        console.error('[玩家卡片] 获取渲染图失败：', e)
        return await quick_action(['⚠️渲染失败，请稍后重试！'])
    }
}