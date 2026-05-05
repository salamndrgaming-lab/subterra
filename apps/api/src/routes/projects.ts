import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { query } from '../db.js';

export const projectsRouter = Router();

const ProjectBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#f59e0b'),
});

projectsRouter.use(requireAuth);

interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  color: string;
  is_archived: boolean;
  created_at: Date;
  updated_at: Date;
}

const select = `
  SELECT id, user_id, name, description, color, is_archived, created_at, updated_at
    FROM projects
`;

function rowToJson(r: ProjectRow) {
  return {
    id: r.id,
    userId: r.user_id,
    name: r.name,
    description: r.description,
    color: r.color,
    isArchived: r.is_archived,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

projectsRouter.get('/', async (req, res, next) => {
  try {
    const result = await query<ProjectRow>(
      `${select} WHERE user_id = $1 AND is_archived = false ORDER BY updated_at DESC`,
      [req.user!.id],
    );
    res.json({ projects: result.rows.map(rowToJson) });
  } catch (err) {
    next(err);
  }
});

projectsRouter.post('/', async (req, res, next) => {
  try {
    const body = ProjectBody.parse(req.body);
    const result = await query<ProjectRow>(
      `INSERT INTO projects (user_id, name, description, color)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, name, description, color, is_archived, created_at, updated_at`,
      [req.user!.id, body.name, body.description ?? null, body.color],
    );
    res.status(201).json({ project: rowToJson(result.rows[0]!) });
  } catch (err) {
    next(err);
  }
});

projectsRouter.patch('/:id', async (req, res, next) => {
  try {
    const partial = ProjectBody.partial().parse(req.body);
    const fields: string[] = [];
    const params: unknown[] = [req.params.id, req.user!.id];
    if (partial.name !== undefined) { params.push(partial.name); fields.push(`name = $${params.length}`); }
    if (partial.description !== undefined) { params.push(partial.description); fields.push(`description = $${params.length}`); }
    if (partial.color !== undefined) { params.push(partial.color); fields.push(`color = $${params.length}`); }
    if (!fields.length) {
      const r = await query<ProjectRow>(`${select} WHERE id = $1 AND user_id = $2`, [req.params.id, req.user!.id]);
      if (!r.rows.length) throw new HttpError(404, 'not_found', 'Project not found');
      res.json({ project: rowToJson(r.rows[0]!) });
      return;
    }
    const result = await query<ProjectRow>(
      `UPDATE projects SET ${fields.join(', ')} WHERE id = $1 AND user_id = $2
       RETURNING id, user_id, name, description, color, is_archived, created_at, updated_at`,
      params,
    );
    if (!result.rows.length) throw new HttpError(404, 'not_found', 'Project not found');
    res.json({ project: rowToJson(result.rows[0]!) });
  } catch (err) {
    next(err);
  }
});

projectsRouter.delete('/:id', async (req, res, next) => {
  try {
    const result = await query(`DELETE FROM projects WHERE id = $1 AND user_id = $2`, [req.params.id, req.user!.id]);
    if (!result.rowCount) throw new HttpError(404, 'not_found', 'Project not found');
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
