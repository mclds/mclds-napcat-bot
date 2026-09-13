import { PrivateFriendMessage, SendMessageSegment } from "node-napcat-ts"

export { }

declare global {
    type QuickAction = (msgs: (string | SendMessageSegment)[], at_sender?: boolean) => Promise<void>

    interface Command {
        name: string
        args: string
        desc: string
        /** 是否公开命令（所有人可用，无需群管理权限） */
        public?: boolean
        handler: (args: string[], quick_action: QuickAction, ctx: any) => void | Promise<void>
    }

    interface VerifySuccessData {
        qq: string
        uuid: string
        time: string
        names: string[]
    }

    interface VerifyWhiteListData {
        reason: string
        uuid: string
        names: string[]
    }

    interface VerifyRecordData{
        uuid: string
        name: string
        code: string
    }
}