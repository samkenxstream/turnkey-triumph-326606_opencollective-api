import DataLoader from 'dataloader';
import { groupBy, partition, uniq } from 'lodash';

import models, { sequelize } from '../../models';

export const generateAdminUsersEmailsForCollectiveLoader = () => {
  return new DataLoader(
    async (collectives: typeof models.Collective[]) => {
      const [userCollectives, otherCollectives] = partition(collectives, collective => collective.type === 'USER');
      const queries = [];

      if (userCollectives.length > 0) {
        queries.push(`
          SELECT users."CollectiveId" AS "CollectiveId", users.email
          FROM "Users" users
          WHERE users."CollectiveId" IN (:userCollectiveIds)
          AND users."deletedAt" IS NULL
        `);
      }

      if (otherCollectives.length > 0) {
        queries.push(`
          SELECT member."CollectiveId" AS "CollectiveId", users.email
          FROM "Users" users
          INNER JOIN "Members" member ON member."MemberCollectiveId" = users."CollectiveId"
          WHERE member."CollectiveId" IN (:otherCollectivesIds)
          AND member.role = 'ADMIN'
          AND member."deletedAt" IS NULL
          AND users."deletedAt" IS NULL
        `);
      }

      const result = await sequelize.query(queries.join('UNION ALL'), {
        type: sequelize.QueryTypes.SELECT,
        replacements: {
          userCollectiveIds: userCollectives.map(collective => collective.id),
          otherCollectivesIds: otherCollectives.map(collective => collective.id),
        },
      });

      const resultByCollective = groupBy(result, 'CollectiveId');
      return collectives.map(collective => {
        if (resultByCollective[collective.id]) {
          return uniq(resultByCollective[collective.id].map(entry => entry.email));
        } else {
          return [];
        }
      });
    },
    {
      cacheKeyFn: (collective: typeof models.Collective) => collective.id,
    },
  );
};
