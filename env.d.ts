import { PrivateFriendMessage } from "node-napcat-ts"

export { }

declare global {
    interface Command {
        name: string
        desc: string
        handler: (ctx: PrivateFriendMessage | PrivateGroupMessage) => void
    }
}