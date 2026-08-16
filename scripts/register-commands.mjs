const applicationId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_TOKEN;

if (!applicationId || !token) {
  throw new Error("DISCORD_APPLICATION_ID and DISCORD_TOKEN are required");
}

const commands = [
  {
    name: "monitor",
    description: "URLの生存確認を管理します",
    integration_types: [0],
    contexts: [0],
    default_member_permissions: "32",
    options: [
      {
        type: 1,
        name: "add",
        description: "監視先を追加します",
        options: [
          {
            type: 3,
            name: "name",
            description: "障害通知に表示する名前",
            required: true,
            max_length: 80,
          },
          {
            type: 3,
            name: "url",
            description: "監視するHTTP/HTTPS URL",
            required: true,
            max_length: 2048,
          },
        ],
      },
      { type: 1, name: "list", description: "このサーバーの監視先を表示します" },
      {
        type: 1,
        name: "remove",
        description: "監視先を削除します",
        options: [
          {
            type: 3,
            name: "name",
            description: "登録時の名前",
            required: true,
            max_length: 80,
          },
        ],
      },
    ],
  },
];

const response = await fetch(
  `https://discord.com/api/v10/applications/${applicationId}/commands`,
  {
    method: "PUT",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  },
);

if (!response.ok) {
  throw new Error(`${response.status}: ${await response.text()}`);
}

console.log(JSON.stringify(await response.json(), null, 2));
