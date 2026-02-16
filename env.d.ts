import { PrivateFriendMessage } from "node-napcat-ts"

export { }

declare global {
    interface Command {
        name: string
        args: string
        desc: string
        handler: (args: string[], quick_action: (msgs: string[])=> Promise<void>) => void | Promise<void>
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
    }
}