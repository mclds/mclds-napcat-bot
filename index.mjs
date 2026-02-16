import { NCWebsocket, Structs } from 'node-napcat-ts'
import dotenv from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename } from 'path';

dotenv.config();

const config = {
    host: process.env.HOST,
    port: process.env.PORT,
    token: process.env.TOKEN,
    group_id: process.env.GROUP_ID,
    chat_history_save_path: process.env.CHAT_HISTORY_SAVE_PATH,
    max_chat_history: parseInt(process.env.MAX_CHAT_HISTORY ?? '100'),
    verify_records_file: process.env.VERIFY_RECORDS_FILE,
    verify_whitelist_file: process.env.VERIFY_WHITELIST_FILE,
    verify_success_file: process.env.VERIFY_SUCCESS_FILE,
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
    await napcat.connect()
    console.log('连接成功！');

    napcat.on('message', async (ctx) => {

        /**
         * 
         * @param {string[]} msgs
         */
        const quick_action = async (msgs = []) => {
            await napcat.send_private_msg({
                user_id: ctx.user_id,
                message: msgs.map(s => (Structs.text(s)))
            })
        }

        // 群聊天记录保存
        if (ctx.message_type === 'group' && ctx.group_id === parseInt(config.group_id?.toString() || '0')) {
            if (config.chat_history_save_path && existsSync(config.chat_history_save_path)) {
                const data = JSON.parse(readFileSync(config.chat_history_save_path, { encoding: 'utf-8' }))
                const records = data['records']
                if (records.length > config.max_chat_history) {
                    records.shift()
                }
                records.push(ctx)
                writeFileSync(config.chat_history_save_path, JSON.stringify(data))
            }

        }


        // 进服验证
        if (ctx.message_type === 'private') {
            const messages = ctx.message.map(m => m.type === 'text' ? m.data.text.trim() : '').filter(Boolean)
            console.log('[私信]', ctx.sender.nickname, ctx.sender.user_id.toString(), '=>', messages)

            try {


                // 管理员命令
                if (registered_commands.length > 0) {
                    const [send_command] = (messages[0] || '').match(/\/([a-zA-Z\u4e00-\u9fa5_-])/) || []
                    if (send_command) {
                        // 检查管理员权限
                        const info = await napcat.get_group_member_info({
                            group_id: parseInt(config.group_id || ''),
                            user_id: ctx.user_id
                        })
                        if (info.role === 'member') {
                            return await quick_action(['⚠️你无权使用命令'])
                        }


                        try {
                            const match_command = registered_commands.find(c => {
                                return ((messages[0] || '')).split(' ')[0] === (c.name) || ((messages[0] || '')).split(' ')[0] === ('/' + c.name)
                            })
                            if (match_command) {
                                const msgs = ctx.message.map(m => String(Reflect.get(m.data, 'text')) || '')
                                const [cmd, ...args] = msgs[0].split(' ').filter(s => s.trim())
                                await match_command.handler(args, quick_action)
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
                            names: []
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

        if(!id){
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

        writeFileSync(config.verify_records_file, JSON.stringify({ records: records_json.filter(r => r.uuid === record.uuid) }))
        writeFileSync(config.verify_whitelist_file, JSON.stringify({ whitelist: whitelist_json }))
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


    // registerCommand('update-nickname', '更新群里玩家的游戏昵称', (ctx) => { 
    // })
})()





process.on('unhandledRejection', console.error)
process.on('uncaughtException', console.error)




/**
 * 
 * @param {string} name   
 * @param {Command['handler']} handler 
 */
function registerCommand(name = '', args = '', desc = '', handler) {
    registered_commands.push({
        name,
        args,
        desc,
        handler
    })
}