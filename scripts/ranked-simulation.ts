interface Ticket {
  userId: string;
  rating: number;
  joinedAt: number;
  cancelled: boolean;
}

interface Match {
  userIds: string[];
  averageRating: number;
  ratingSpread: number;
  waitMs: number;
}

const users = Array.from({ length: Number(process.env.RANKED_USERS ?? 1000) }, (_, index) => ({
  userId: `user_${index}`,
  rating: 800 + ((index * 37) % 900),
}));

const tickets: Ticket[] = users.map((user, index) => ({
  ...user,
  joinedAt: index * 120,
  cancelled: index % 41 === 0,
}));

const activeTickets = tickets.filter((ticket) => !ticket.cancelled).sort((left, right) => left.joinedAt - right.joinedAt);
const matches: Match[] = [];
const matchedUsers = new Set<string>();

for (const ticket of activeTickets) {
  if (matchedUsers.has(ticket.userId)) continue;
  const waitMs = Math.max(0, matches.length * 250 - ticket.joinedAt);
  const ratingWindow = 80 + Math.floor(waitMs / 15_000) * 40;
  const group = activeTickets
    .filter((candidate) => !matchedUsers.has(candidate.userId))
    .filter((candidate) => Math.abs(candidate.rating - ticket.rating) <= ratingWindow)
    .sort((left, right) => Math.abs(left.rating - ticket.rating) - Math.abs(right.rating - ticket.rating))
    .slice(0, 4);
  if (group.length < 4) continue;
  for (const candidate of group) matchedUsers.add(candidate.userId);
  const ratings = group.map((candidate) => candidate.rating);
  matches.push({
    userIds: group.map((candidate) => candidate.userId),
    averageRating: ratings.reduce((sum, value) => sum + value, 0) / ratings.length,
    ratingSpread: Math.max(...ratings) - Math.min(...ratings),
    waitMs,
  });
}

const duplicateMatchedUsers = [...matchedUsers].length !== matchedUsers.size;
const averageWaitMs = matches.reduce((sum, match) => sum + match.waitMs, 0) / Math.max(matches.length, 1);
const averageSpread = matches.reduce((sum, match) => sum + match.ratingSpread, 0) / Math.max(matches.length, 1);
const abandonmentRate = tickets.filter((ticket) => ticket.cancelled).length / tickets.length;

const result = {
  tickets: tickets.length,
  cancelledTickets: tickets.filter((ticket) => ticket.cancelled).length,
  matches: matches.length,
  matchedUsers: matchedUsers.size,
  duplicateMatchedUsers,
  averageWaitMs,
  averageRatingSpread: averageSpread,
  abandonmentRate,
};

if (duplicateMatchedUsers) throw new Error("A user was matched more than once");
console.log(JSON.stringify(result, null, 2));
