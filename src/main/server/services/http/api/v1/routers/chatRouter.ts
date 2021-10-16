import { RouterContext } from "koa-router";
import { Next } from "koa";

import { Server } from "@server/index";
import { checkPrivateApiStatus } from "@server/helpers/utils";
import { ErrorTypes } from "@server/types";
import {
    createBadRequestResponse,
    createNotFoundResponse,
    createServerErrorResponse,
    createSuccessResponse
} from "@server/helpers/responses";
import { getChatResponse } from "@server/databases/imessage/entity/Chat";
import { getMessageResponse } from "@server/databases/imessage/entity/Message";
import { DBMessageParams } from "@server/databases/imessage/types";

import { parseNumber } from "../../../helpers";
import { ChatInterface } from "../interfaces/chatInterface";

export class ChatRouter {
    static async count(ctx: RouterContext, _: Next) {
        const chats = await Server().iMessageRepo.getChats({ withSMS: true });
        const serviceCounts: { [key: string]: number } = {};
        for (const chat of chats) {
            if (!Object.keys(serviceCounts).includes(chat.serviceName)) {
                serviceCounts[chat.serviceName] = 0;
            }

            serviceCounts[chat.serviceName] += 1;
        }

        ctx.body = createSuccessResponse({
            total: chats.length,
            breakdown: serviceCounts
        });
    }

    static async find(ctx: RouterContext, _: Next) {
        const withQuery = ((ctx.request.query.with ?? "") as string)
            .toLowerCase()
            .split(",")
            .map(e => e.trim());
        const withParticipants = withQuery.includes("participants");
        const withLastMessage = withQuery.includes("lastmessage");

        const chats = await Server().iMessageRepo.getChats({
            chatGuid: ctx.params.guid,
            withSMS: true,
            withParticipants
        });

        if (!chats || chats.length === 0) {
            ctx.status = 404;
            ctx.body = createNotFoundResponse("Chat does not exist!");
            return;
        }

        const res = await getChatResponse(chats[0]);
        if (withLastMessage) {
            res.lastMessage = await getMessageResponse(await Server().iMessageRepo.getChatLastMessage(ctx.params.guid));
        }

        ctx.body = createSuccessResponse(res);
    }

    static async getMessages(ctx: RouterContext, _: Next) {
        const withQuery = ((ctx.request.query.with ?? "") as string)
            .toLowerCase()
            .split(",")
            .map(e => e.trim());
        const withAttachments = withQuery.includes("attachment") || withQuery.includes("attachments");
        const withHandle = withQuery.includes("handle") || withQuery.includes("handles");
        const withSMS = withQuery.includes("sms");
        const sort = ["DESC", "ASC"].includes(((ctx.request.query?.sort as string) ?? "").toLowerCase())
            ? ctx.request.query?.sort
            : "DESC";
        const after = ctx.request.query?.after;
        const before = ctx.request.query?.before;

        // Pull the pagination params and make sure they are correct
        let offset = parseNumber(ctx.request.query?.offset as string) ?? 0;
        let limit = parseNumber(ctx.request.query?.limit as string) ?? 100;
        if (offset < 0) offset = 0;
        if (limit < 0 || limit > 1000) limit = 1000;

        const chats = await Server().iMessageRepo.getChats({
            chatGuid: ctx.params.guid,
            withSMS: true,
            withParticipants: false
        });

        if (!chats || chats.length === 0) {
            ctx.status = 404;
            ctx.body = createNotFoundResponse("Chat does not exist!");
            return;
        }

        const opts: DBMessageParams = {
            chatGuid: ctx.params.guid,
            withAttachments,
            withHandle,
            withSMS,
            offset,
            limit,
            sort: sort as "ASC" | "DESC",
            before: Number.parseInt(before as string, 10),
            after: Number.parseInt(after as string, 10)
        };

        // Fetch the info for the message by GUID
        const messages = await Server().iMessageRepo.getMessages(opts);
        const results = [];
        for (const msg of messages ?? []) {
            results.push(await getMessageResponse(msg));
        }

        ctx.body = createSuccessResponse(results);
    }

    static async query(ctx: RouterContext, _: Next) {
        const { body } = ctx.request;

        // Pull out the filters
        const withQuery = (body?.with ?? [])
            .filter((e: any) => typeof e === "string")
            .map((e: string) => e.toLowerCase().trim());
        const withParticipants = withQuery.includes("participants");
        const withLastMessage = withQuery.includes("lastmessage");
        const withSMS = withQuery.includes("sms");
        const withArchived = withQuery.includes("archived");
        const guid = body?.guid;
        let sort = body?.sort ?? "";

        // Validate sort param
        if (typeof sort !== "string") {
            ctx.status = 400;
            ctx.body = createBadRequestResponse("Sort parameter must be a string!");
            return;
        }

        sort = sort.toLowerCase();
        const validSorts = ["lastmessage"];
        if (!validSorts.includes(sort)) {
            sort = null;
        }

        // Pull the pagination params and make sure they are correct
        let offset = parseNumber(body?.offset as string) ?? 0;
        let limit = parseNumber(body?.limit as string) ?? 1000;
        if (offset < 0) offset = 0;
        if (limit < 0 || limit > 1000) limit = 1000;

        const results = await ChatInterface.get({
            guid,
            withSMS,
            withParticipants,
            withLastMessage,
            withArchived,
            offset,
            limit,
            sort
        });

        // Build metadata to return
        const metadata = {
            total: await Server().iMessageRepo.getChatCount(),
            offset,
            limit
        };

        ctx.body = createSuccessResponse(results, null, metadata);
    }

    static async update(ctx: RouterContext, _: Next): Promise<void> {
        const { body } = ctx.request;
        const { guid } = ctx.params;
        const displayName = body?.displayName;

        const enablePrivateApi = Server().repo.getConfig("enable_private_api") as boolean;
        if (!enablePrivateApi) {
            ctx.status = 404;
            ctx.body = createServerErrorResponse("Private API is not enabled!", ErrorTypes.IMESSAGE_ERROR);
            return;
        }

        const chats = await Server().iMessageRepo.getChats({ chatGuid: guid, withParticipants: true });
        if (!chats || chats.length === 0) {
            ctx.status = 404;
            ctx.body = createNotFoundResponse("Chat does not exist!");
            return;
        }

        let chat = chats[0];

        const updated = [];
        const errors: string[] = [];
        if (displayName && displayName.length !== 0) {
            try {
                chat = await ChatInterface.setDisplayName(chat, displayName);
                updated.push("displayName");
            } catch (ex: any) {
                errors.push(ex?.message ?? ex);
            }
        }

        if (errors && errors.length > 0) {
            ctx.body = createServerErrorResponse(
                errors.join(", "),
                ErrorTypes.IMESSAGE_ERROR,
                `Chat update executed with errors!`
            );
        } else if (updated.length === 0) {
            ctx.body = createSuccessResponse(
                await getChatResponse(chat),
                "Chat not updated! No update information provided!"
            );
        } else {
            ctx.body = createSuccessResponse(
                await getChatResponse(chat),
                `Successfully updated the following fields: ${updated.join(", ")}`
            );
        }
    }

    static async create(ctx: RouterContext, _: Next): Promise<void> {
        const { body } = ctx.request;
        const addresses = body?.addresses;

        const enablePrivateApi = Server().repo.getConfig("enable_private_api") as boolean;
        if (!enablePrivateApi) {
            ctx.status = 404;
            ctx.body = createServerErrorResponse("Private API is not enabled!", ErrorTypes.IMESSAGE_ERROR);
            return;
        }

        await ChatInterface.create(addresses);

        ctx.body = createSuccessResponse(null, `Successfully executed create chat command!`);
    }

    static async addParticipant(ctx: RouterContext, next: Next): Promise<void> {
        await ChatRouter.toggleParticipant(ctx, next, "add");
    }

    static async removeParticipant(ctx: RouterContext, next: Next): Promise<void> {
        await ChatRouter.toggleParticipant(ctx, next, "remove");
    }

    static async toggleParticipant(ctx: RouterContext, _: Next, action: "add" | "remove"): Promise<void> {
        const { body } = ctx.request;
        const { guid } = ctx.params;
        const address = body?.address;

        // Make sure we have a connection
        checkPrivateApiStatus();

        if (!address || address.length === 0) {
            ctx.status = 404;
            ctx.body = createNotFoundResponse("Participant address not provided!");
            return;
        }

        const chats = await Server().iMessageRepo.getChats({ chatGuid: guid, withParticipants: false });
        if (!chats || chats.length === 0) {
            ctx.status = 404;
            ctx.body = createNotFoundResponse("Chat does not exist!");
            return;
        }

        // Add the participant to the chat
        let chat = chats[0];
        chat = await ChatInterface.toggleParticipant(chat, address, action);

        ctx.body = createSuccessResponse(await getChatResponse(chat), `Successfully added participant!`);
    }
}
