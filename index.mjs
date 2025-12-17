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
    verify_success_file: process.env.VERIFY_SUCCESS_FILE,
    /** 查询限制 */
    query_limit_seconds: 3,
    code_length: 4,
    admin_qq_id: process.env.ADMIN_QQ_ID,
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

            // 管理员命令
            if (config.admin_qq_id && ctx.sender.user_id.toString() === config.admin_qq_id && registered_commands.length > 0) {
                const [send_command] = (messages[0] || '').match(/\/([a-zA-Z_-])/) || []
                if (send_command) {
                    try {
                        const match_command = registered_commands.find(c => {
                            return send_command === c.name
                        })
                        if (match_command) {
                            match_command.handler(ctx)
                        } else {
                            ctx.quick_action([
                                Structs.text('未找到到相应命令，当前可用命令如下：'),
                                ...(registered_commands.map(c => Structs.text(`/${c.name}  ${c.desc}`)))
                            ])
                        }
                    } catch (e) {
                        console.error(e)
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
                        ctx.quick_action([Structs.text('⚠️群数据错误！请联系管理员')])
                        return
                    }

                    // QQ
                    const qq = String(ctx.user_id)


                    if (limits.get(qq)) {
                        const time = limits.get(qq)
                        if (Date.now() - time < config.query_limit_seconds * 1000) {
                            ctx.quick_action([Structs.text('⚠️查询太频繁了，请稍后再试！')])
                            return
                        }
                    }

                    limits.set(qq, Date.now())


                    const record_index = json.findIndex(j => j.code === code)
                    if (record_index === -1) {
                        ctx.quick_action([Structs.text('⚠️未查询到验证数据！请检查验证码是否正确，或者是否过期，或者联系管理员处理。')])
                        return
                    }

                    //  查找用户是否加群 
                    const members = await napcat.get_group_member_list({ group_id: parseInt(config.group_id), no_cache: true })
                    const member_infos = members.map(m => ({ qq: String(m.user_id), card: m.card }))

                    if (member_infos.find(i => String(i.qq) === qq) === undefined) {
                        ctx.quick_action([Structs.text('⚠️检测到您尚未加群！' + config.group_id)])
                        return
                    }

                    const uuid = json[record_index].uuid
                    if (!config.verify_success_file) {
                        ctx.quick_action([Structs.text('⚠️数据保存路径不存在！请联系服务器管理员')])
                        return
                    }

                    mkdirSync(basename(config.verify_success_file), { recursive: true })
                    if (existsSync(config.verify_success_file) === false) {
                        writeFileSync(config.verify_success_file, JSON.stringify({ records: [] }))
                    }

                    const verify_data = JSON.parse(readFileSync(config.verify_success_file, { encoding: 'utf-8' }))
                    const verify_json = verify_data['records']
                    const verified = verify_json.find(j => String(j.qq) === qq)
                    if (verified) {
                        ctx.quick_action([Structs.text(`⚠️当前QQ号已经存在绑定！请联系管理员处理`)])
                        return
                    }

                    // 验证成功
                    ctx.quick_action([Structs.text('🎉验证成功！欢迎加入光梦服务器，重新进服即可。')])
                    json.splice(record_index, 1)
                    writeFileSync(config.verify_records_file, JSON.stringify(data))


                    verify_json.push({
                        qq: qq,
                        uuid: uuid,
                        time: new Date().toLocaleString('zh-cn')
                    })
                    writeFileSync(config.verify_success_file, JSON.stringify(verify_data))
                    return
                }

                ctx.quick_action([Structs.text('⚠️机器人只支持服务器进服验证消息，格式为4-6位数字，其他问题请联系群腐竹哦~')])
            }
        }
    })



    registerCommand('get-qq-by-name', '根据游戏ID查询QQ', (ctx) => {

    })


    // registerCommand('update-nickname', '更新群里玩家的游戏昵称', (ctx) => {
    //     const  id = parseInt(config.group_id?.toString() || '0')
    //     if(!id) return
    //     napcat.get_group_member_list({ group_id:  id }).then(res=>{
    //         napcat.set_group_card({
    //             group_id: id
    //         })
    //     }).catch(console.error)
    // })
})()

















/**
 * 
 * @param {string} name 
 * @param {Command['handler']} handler 
 */
function registerCommand(name = '', desc = '', handler) {
    registered_commands.push({
        name,
        desc,
        handler
    })
}