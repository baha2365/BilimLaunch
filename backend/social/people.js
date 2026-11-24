/**
 * How a person appears in any list of people (followers, following, search,
 * who liked a post): the public bits only, plus how they relate to the viewer.
 * Shared by social/router.js and posts/router.js.
 */
const { avatarUrlOf } = require("../auth/users");

// $1 is always the viewer's user id; `u` is the person being described.
const PERSON_COLUMNS = `
  u.id, u.username, u.full_name, u.avatar_url, u.avatar_key, u.role,
  u.id = $1 AS is_me,
  EXISTS (SELECT 1 FROM follows x WHERE x.follower_id = $1 AND x.followee_id = u.id) AS is_following,
  EXISTS (SELECT 1 FROM follows x WHERE x.follower_id = u.id AND x.followee_id = $1) AS follows_you`;

function presentPerson(row) {
  return {
    username: row.username,
    fullName: row.full_name,
    avatarUrl: avatarUrlOf(row.avatar_key, row.avatar_url),
    isTeam: row.role === "admin",
    isMe: row.is_me,
    isFollowing: row.is_following,
    followsYou: row.follows_you,
  };
}

module.exports = { PERSON_COLUMNS, presentPerson };
