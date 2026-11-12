# GDPSNode-compat

This plugin adapts the older GD protocols to make GDPSNode compatible with **ALL** the Geometry Dash versions. Cvolton's server was used as a reference.

Clone it to your plugins directory and restart the server to enable it.

## Implemented

The plugin brings back:
- legacy messages
- unregistered level uploads, comments, likes, and ratings
- login for older clients
- compatible versions of new endpoints, check the full list in `DETAILS.md`

And it adds:
- message bridge between legacy messages and new DMs
- legacy group chats
- news subscriptions

What it does **not** add:
- level conversion to older versions

## Legacy messages

The DM is forwarded to the legacy message system, and vice versa.  
If the legacy message subject starts with "Re: ", it's stripped to avoid chat pollution.  
If the message contains non-ASCII characters, the legacy message will contain UTF-8 codes of the characters instead of the characters themselves. This is a limitation of the legacy message system.

Group chats are also implemented for legacy users via legacy messages. They are painful to use, but there's no better way.

Also, users can subscribe to legacy news messages.

## Chat commands

All the commands should arrive at GDPSnode Notifications (account 71) in the message body. The subject is ignored.

Available commands:
- `message_bridge 1` / `message_bridge 0`: makes the new DMs appear in legacy messages (other direction is always on). Default: 0
- `subscribe_news` / `unsubscribe_news`: subscribe or unsubscribe from local news articles. Default: unsubscribed.
- `legacy notif 1` / `legacy notif 0`: sends a notification when you get a legacy message. Default: 1

## Legacy group chats

Group invitations, messages and commands arrive to and from GDPSnode Notifications (account 71). Set the subject to "group ID" to send a message to a group.

The following group commands are available (`ID` is the group ID):

- `create_group name="name here" desc="description here"`: create a group owned by you (name up to 64 characters; description up to 500). The reply includes its ID.
- `accept_group ID` / `deny_group ID`: accept or decline an invitation.
- `list_group_members ID`: list the active members of a joined group.
- `report_group ID`: report an invited or joined group with reason `inappropriate content`.
- `leave_group ID`: leave a joined group.
- `list_joined_groups`: list joined groups as `group id - group name`, one per line.

Send these commands in a legacy message body **to the target user**, with any subject:

- `invite_to_group ID`: invite that user, subject to the normal invitation permissions and privacy rules.
- `transfer_group ID`: transfer ownership to that user, who must have joined. Only the owner can transfer.
- `kick_from_group ID`: remove that joined user. Requires ownership or moderator permissions.

These messages perform the action instead of delivering a normal message. 
Newly created groups start with only the owner; invite another user and have them accept before chatting.

Deleting the original message (either legacy or new) will delete all the linked copies too.

## Configuration

Edit `config.js` in this directory and restart the server to apply changes.

| Option | Behavior                                                                                                                                         |
| --- |--------------------------------------------------------------------------------------------------------------------------------------------------|
| `min_binary_version` | Reject requests below this binary version with `-1`, including modern endpoints. `0` disables the limit.                                         |
| `allow_1.0_likes` | Allow the original `likeGJLevel.php` route.                                                                                                      |
| `allow_unregistered_level_uploads` | Allow level uploads without an account.                                                                                                          |
| `allow_unregistered_comments` | Allow level comments without an account.                                                                                                         |
| `allow_unregistered_likes` | Allow likes/dislikes without an account, including original 1.0 likes.                                                                           |
| `allow_unregistered_rates` | Allow level rating without an account.                                                                                                           |
| `allow_message_bridge` | Enable message bridging, notification commands, group bridging, and news subscriptions. Disabling this keeps ordinary legacy messages available. |
| `allow_insecure_login` | Allow plaintext login/registration over HTTP. Disabled by default; enabling it prints a startup warning.                                         |

GD 1.0 sends no identification info when liking a level, so it's deduced from the IP address and has a limit of 3 likes per level per IP (copied from Cvolton's server). That's why there's an option to disable them.
